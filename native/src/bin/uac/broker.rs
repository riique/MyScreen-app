use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Pipes::*, RemoteDesktop::*, Services::*, Threading::*},
};

const NAME: &str = "MyScreenUac";
const PIPE: &str = r"\\.\pipe\myscreen-uac-broker-v1";
static STOP: AtomicBool = AtomicBool::new(false);

pub struct Handle(pub HANDLE);
impl Handle {
    pub fn new(handle: HANDLE) -> io::Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}

fn require(ok: BOOL) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn denied() -> io::Error {
    io::Error::from(io::ErrorKind::PermissionDenied)
}

fn valid_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--service"] => {
            let name = wide(NAME);
            let table = [
                SERVICE_TABLE_ENTRYW {
                    lpServiceName: name.as_ptr().cast_mut(),
                    lpServiceProc: Some(service_main),
                },
                SERVICE_TABLE_ENTRYW {
                    lpServiceName: null_mut(),
                    lpServiceProc: None,
                },
            ];
            require(unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) })
        }
        ["--authorize", pid, nonce] if valid_nonce(nonce) => authorize(parse_pid(pid)?, nonce),
        ["--worker", pid, nonce] if valid_nonce(nonce) => {
            crate::desktop::run(parse_pid(pid)?, nonce)
        }
        _ => Err(io::Error::from(io::ErrorKind::InvalidInput)),
    }
}

fn parse_pid(text: &str) -> io::Result<u32> {
    text.parse().ok().filter(|pid| *pid != 0).ok_or_else(denied)
}

unsafe extern "system" fn service_control(code: u32) {
    if code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN {
        STOP.store(true, Ordering::Release);
    }
}

unsafe extern "system" fn service_main(_: u32, _: *mut windows_sys::core::PWSTR) {
    let handle = RegisterServiceCtrlHandlerW(wide(NAME).as_ptr(), Some(service_control));
    if handle.is_null() {
        return;
    }
    let mut status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: SERVICE_START_PENDING,
        dwControlsAccepted: 0,
        dwWin32ExitCode: 0,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 1,
        dwWaitHint: 3000,
    };
    SetServiceStatus(handle, &status);
    let result = broker_pipe().and_then(|pipe| {
        status.dwCurrentState = SERVICE_RUNNING;
        status.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
        status.dwCheckPoint = 0;
        status.dwWaitHint = 0;
        require(SetServiceStatus(handle, &status))?;
        serve(&pipe)
    });
    status.dwCurrentState = SERVICE_STOPPED;
    status.dwControlsAccepted = 0;
    status.dwWin32ExitCode = result.err().and_then(|err| err.raw_os_error()).unwrap_or(0) as u32;
    SetServiceStatus(handle, &status);
}

fn broker_pipe() -> io::Result<Handle> {
    let mut descriptor = null_mut();
    unsafe {
        require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)").as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        ))?;
        let attrs = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let pipe = CreateNamedPipeW(
            wide(PIPE).as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            128,
            128,
            0,
            &attrs,
        );
        LocalFree(descriptor);
        Handle::new(pipe)
    }
}

fn serve(pipe: &Handle) -> io::Result<()> {
    let mut worker: Option<Handle> = None;
    while !STOP.load(Ordering::Acquire) {
        let connected = unsafe { ConnectNamedPipe(pipe.0, null_mut()) };
        let code = unsafe { GetLastError() };
        if code == ERROR_PIPE_CONNECTED || (connected != 0 && client_session(pipe).is_ok()) {
            let allowed = worker.as_ref().is_none_or(|h| !running(h));
            let result = if allowed {
                read_request(pipe).and_then(|(pid, nonce, session)| launch(pid, &nonce, session))
            } else {
                Err(denied())
            };
            let mut written = 0;
            let reply = [u8::from(result.is_ok())];
            unsafe {
                WriteFile(pipe.0, reply.as_ptr(), 1, &mut written, null_mut());
                // The client closes after it reads the acknowledgement.
            }
            if let Ok(child) = result {
                worker = Some(child);
            }
            let until = Instant::now() + Duration::from_millis(500);
            while Instant::now() < until && !STOP.load(Ordering::Acquire) && available(pipe).is_ok()
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            unsafe { DisconnectNamedPipe(pipe.0) };
        } else {
            if connected != 0 {
                continue;
            }
            if code != ERROR_PIPE_LISTENING && code != ERROR_NO_DATA {
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            if code == ERROR_NO_DATA {
                unsafe { DisconnectNamedPipe(pipe.0) };
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    if let Some(child) = worker.filter(running) {
        unsafe { TerminateProcess(child.0, 0) };
    }
    Ok(())
}

fn read_request(pipe: &Handle) -> io::Result<(u32, String, u32)> {
    let until = Instant::now() + Duration::from_secs(1);
    while available(pipe)? == 0 {
        if Instant::now() >= until || STOP.load(Ordering::Acquire) {
            return Err(denied());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut message = [0u8; 68];
    let mut count = 0;
    unsafe {
        require(ReadFile(
            pipe.0,
            message.as_mut_ptr(),
            message.len() as u32,
            &mut count,
            null_mut(),
        ))?;
    }
    if count != message.len() as u32 {
        return Err(denied());
    }
    let pid = u32::from_le_bytes(message[..4].try_into().unwrap());
    let nonce = std::str::from_utf8(&message[4..]).map_err(|_| denied())?;
    let session = client_session(pipe)?;
    if !valid_nonce(nonce)
        || session == 0
        || session_of(pid)? != session
        || !crate::desktop::eligible(session)
    {
        return Err(denied());
    }
    Ok((pid, nonce.to_owned(), session))
}

fn authorize(pid: u32, nonce: &str) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    if session_of(pid)? != session_of(std::process::id())? {
        return Err(denied());
    }
    let mut pipe = open_pipe(PIPE)?;
    let mut server = 0;
    require(unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server) })?;
    if server != service_pid()? {
        return Err(denied());
    }
    let mut message = [0; 68];
    message[..4].copy_from_slice(&pid.to_le_bytes());
    message[4..].copy_from_slice(nonce.as_bytes());
    pipe.write_all(&message)?;
    let mut reply = [0];
    pipe.read_exact(&mut reply)?;
    if reply == [1] {
        Ok(())
    } else {
        Err(denied())
    }
}

fn client_session(pipe: &Handle) -> io::Result<u32> {
    let mut session = 0;
    require(unsafe { GetNamedPipeClientSessionId(pipe.0, &mut session) })?;
    Ok(session)
}

fn service_pid() -> io::Result<u32> {
    unsafe {
        let manager = OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT);
        if manager.is_null() {
            return Err(io::Error::last_os_error());
        }
        let service = OpenServiceW(manager, wide(NAME).as_ptr(), SERVICE_QUERY_STATUS);
        CloseServiceHandle(manager);
        if service.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut info: SERVICE_STATUS_PROCESS = std::mem::zeroed();
        let mut needed = 0;
        let result = require(QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            (&mut info as *mut SERVICE_STATUS_PROCESS).cast(),
            size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        ));
        CloseServiceHandle(service);
        result?;
        if info.dwCurrentState == SERVICE_RUNNING && info.dwProcessId != 0 {
            Ok(info.dwProcessId)
        } else {
            Err(denied())
        }
    }
}

fn launch(pid: u32, nonce: &str, session: u32) -> io::Result<Handle> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(denied)?;
    let mut args = wide(format!("\"{}\" --worker {pid} {nonce}", exe.display()));
    unsafe {
        let mut source = null_mut();
        require(OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE,
            &mut source,
        ))?;
        let source = Handle::new(source)?;
        let mut token = null_mut();
        require(DuplicateTokenEx(
            source.0,
            TOKEN_ALL_ACCESS,
            null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut token,
        ))?;
        let token = Handle::new(token)?;
        require(SetTokenInformation(
            token.0,
            TokenSessionId,
            (&session as *const u32).cast(),
            4,
        ))?;
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        let mut desktop = wide(r"winsta0\default");
        startup.lpDesktop = desktop.as_mut_ptr();
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        require(CreateProcessAsUserW(
            token.0,
            wide(&exe).as_ptr(),
            args.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_NO_WINDOW,
            null(),
            wide(dir).as_ptr(),
            &startup,
            &mut info,
        ))?;
        CloseHandle(info.hThread);
        Handle::new(info.hProcess)
    }
}

pub fn session_of(pid: u32) -> io::Result<u32> {
    let mut session = 0;
    require(unsafe { ProcessIdToSessionId(pid, &mut session) })?;
    Ok(session)
}

pub fn running(handle: &Handle) -> bool {
    unsafe { WaitForSingleObject(handle.0, 0) == WAIT_TIMEOUT }
}

fn open_pipe(name: &str) -> io::Result<std::fs::File> {
    let handle = unsafe {
        CreateFileW(
            wide(name).as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

pub fn open_app(pid: u32, nonce: &str) -> io::Result<std::fs::File> {
    use std::os::windows::io::AsRawHandle;
    let pipe = open_pipe(&format!(r"\\.\pipe\myscreen-uac-{}", &nonce[..32]))?;
    let mut server = 0;
    require(unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server) })?;
    if pid != server {
        return Err(denied());
    }
    Ok(pipe)
}

pub fn available(pipe: &Handle) -> io::Result<u32> {
    let mut size = 0;
    require(unsafe { PeekNamedPipe(pipe.0, null_mut(), 0, null_mut(), &mut size, null_mut()) })?;
    Ok(size)
}
