use std::io::{self, Read, Write};
use std::mem::ManuallyDrop;
use std::os::windows::io::AsRawHandle;
use std::ptr::null_mut;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::{
    Foundation::{HWND as AutomationHwnd, VARIANT_TRUE},
    System::{
        Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL},
    },
    UI::Accessibility::{
        CUIAutomation8, IUIAutomation, IUIAutomationCondition, TreeScope_Subtree,
        UIA_IsPasswordPropertyId,
    },
};
use windows_sys::Win32::{
    Foundation::{HWND, RECT},
    Security::{
        GetTokenInformation, TokenElevationType, TokenElevationTypeFull, TokenElevationTypeLimited,
    },
    System::{
        Pipes::PeekNamedPipe, Registry::*, RemoteDesktop::*, StationsAndDesktops::*,
        SystemInformation::GetSystemDirectoryW, Threading::*,
    },
    UI::{
        HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
        Input::KeyboardAndMouse::*,
        WindowsAndMessaging::*,
    },
};

use crate::broker::{self, wide, Handle};
use crate::video::Capture;

fn policy(name: &str, default: u32) -> Option<u32> {
    let key = wide(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System");
    let mut value = 0u32;
    let mut size = 4;
    let code = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            wide(name).as_ptr(),
            RRF_RT_REG_DWORD,
            null_mut(),
            (&mut value as *mut u32).cast(),
            &mut size,
        )
    };
    match code {
        0 => Some(value),
        2 => Some(default),
        _ => None,
    }
}

pub fn eligible(session: u32) -> bool {
    if policy("EnableLUA", 1) != Some(1)
        || policy("PromptOnSecureDesktop", 1) != Some(1)
        || !matches!(policy("ConsentPromptBehaviorAdmin", 5), Some(2 | 4 | 5))
        || !unlocked(session)
    {
        return false;
    }
    unsafe {
        let mut token = null_mut();
        if WTSQueryUserToken(session, &mut token) == 0 {
            return false;
        }
        let Ok(token) = Handle::new(token) else {
            return false;
        };
        let mut kind = 0i32;
        let mut size = 0;
        GetTokenInformation(
            token.0,
            TokenElevationType,
            (&mut kind as *mut i32).cast(),
            4,
            &mut size,
        ) != 0
            && (kind == TokenElevationTypeLimited || kind == TokenElevationTypeFull)
    }
}

fn unlocked(session: u32) -> bool {
    unsafe {
        let mut data = null_mut();
        let mut size = 0;
        if WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            session,
            WTSSessionInfoEx,
            &mut data,
            &mut size,
        ) == 0
        {
            return false;
        }
        let result = if size as usize >= size_of::<WTSINFOEXW>() {
            let info = &*data.cast::<WTSINFOEXW>();
            if info.Level == 1 {
                let state = info.Data.WTSInfoExLevel1;
                state.SessionId == session
                    && state.SessionState == WTSActive
                    && state.SessionFlags == WTS_SESSIONSTATE_UNLOCK as i32
            } else {
                false
            }
        } else {
            false
        };
        WTSFreeMemory(data.cast());
        result
    }
}

struct Desktop(HDESK);
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe { CloseDesktop(self.0) };
    }
}

fn input_desktop() -> Option<(Desktop, String)> {
    unsafe {
        let handle = OpenInputDesktop(
            0,
            0,
            DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS | DESKTOP_CREATEWINDOW,
        );
        if handle.is_null() {
            return None;
        }
        let desktop = Desktop(handle);
        let mut name = [0u16; 64];
        if GetUserObjectInformationW(handle, UOI_NAME, name.as_mut_ptr().cast(), 128, null_mut())
            == 0
        {
            return None;
        }
        let end = name.iter().position(|&c| c == 0)?;
        Some((desktop, String::from_utf16_lossy(&name[..end])))
    }
}

#[derive(Clone, Copy)]
struct Prompt {
    window: HWND,
    pid: u32,
    rect: RECT,
}
impl PartialEq for Prompt {
    fn eq(&self, other: &Self) -> bool {
        let a = self.rect;
        let b = other.rect;
        self.window == other.window
            && self.pid == other.pid
            && (a.left, a.top, a.right, a.bottom) == (b.left, b.top, b.right, b.bottom)
    }
}

fn system_consent_path() -> io::Result<String> {
    let mut path = [0u16; 1024];
    let len = unsafe { GetSystemDirectoryW(path.as_mut_ptr(), path.len() as u32) } as usize;
    if len == 0 || len >= path.len() {
        return Err(io::Error::last_os_error());
    }
    Ok(format!(
        "{}\\consent.exe",
        String::from_utf16_lossy(&path[..len])
    ))
}

struct Automation {
    client: IUIAutomation,
    password: IUIAutomationCondition,
}

struct ComApartment;
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

impl Automation {
    fn new() -> windows::core::Result<(ComApartment, Self)> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let apartment = ComApartment;
            let client: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
            let timeouts = client.cast::<windows::Win32::UI::Accessibility::IUIAutomation2>()?;
            timeouts.SetConnectionTimeout(1500)?;
            timeouts.SetTransactionTimeout(1500)?;
            let value = VARIANT {
                Anonymous: VARIANT_0 {
                    Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                        vt: VT_BOOL,
                        Anonymous: VARIANT_0_0_0 {
                            boolVal: VARIANT_TRUE,
                        },
                        ..Default::default()
                    }),
                },
            };
            let password = client.CreatePropertyCondition(UIA_IsPasswordPropertyId, &value)?;
            Ok((apartment, Self { client, password }))
        }
    }

    fn can_share(&self, window: HWND) -> bool {
        unsafe {
            self.client
                .ElementFromHandle(AutomationHwnd(window))
                .and_then(|root| root.FindAll(TreeScope_Subtree, &self.password))
                .and_then(|fields| fields.Length())
                .is_ok_and(|count| count == 0)
        }
    }
}

fn current_prompt(consent: &str) -> Option<Prompt> {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() || IsWindowVisible(window) == 0 {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        let process = Handle::new(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)).ok()?;
        let mut path = [0u16; 1024];
        let mut size = path.len() as u32;
        if QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut size) == 0
            || !String::from_utf16_lossy(&path[..size as usize]).eq_ignore_ascii_case(consent)
        {
            return None;
        }
        let mut rect = std::mem::zeroed::<RECT>();
        if GetWindowRect(window, &mut rect) == 0
            || rect.right <= rect.left
            || rect.bottom <= rect.top
        {
            return None;
        }
        let mut password = false;
        EnumChildWindows(
            window,
            Some(find_password),
            (&mut password as *mut bool) as isize,
        );
        if password {
            return None;
        }
        Some(Prompt { window, pid, rect })
    }
}

unsafe extern "system" fn find_password(window: HWND, found: isize) -> i32 {
    let mut class = [0u16; 32];
    let size = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
    if size > 0
        && String::from_utf16_lossy(&class[..size as usize]).eq_ignore_ascii_case("Edit")
        && IsWindowVisible(window) != 0
        && GetWindowLongPtrW(window, GWL_STYLE) & ES_PASSWORD as isize != 0
    {
        *(found as *mut bool) = true;
        return 0;
    }
    1
}

fn click(prompt: Prompt, x: u16, y: u16) {
    unsafe {
        use windows_sys::Win32::Foundation::POINT;
        let rect = prompt.rect;
        let point = POINT {
            x: rect.left + ((rect.right - rect.left - 1) as i64 * i64::from(x) / 65535) as i32,
            y: rect.top + ((rect.bottom - rect.top - 1) as i64 * i64::from(y) / 65535) as i32,
        };
        if GetAncestor(WindowFromPoint(point), GA_ROOT) != prompt.window
            || GetForegroundWindow() != prompt.window
        {
            return;
        }
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width < 2 || height < 2 {
            return;
        }
        let event = |flags| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: ((i64::from(point.x - left) * 65536 + 32768) / i64::from(width)) as i32,
                    dy: ((i64::from(point.y - top) * 65536 + 32768) / i64::from(height)) as i32,
                    dwFlags: flags,
                    mouseData: 0,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let events = [
            event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE),
            event(MOUSEEVENTF_LEFTDOWN),
            event(MOUSEEVENTF_LEFTUP),
        ];
        SendInput(
            events.len() as u32,
            events.as_ptr(),
            size_of::<INPUT>() as i32,
        );
    }
}

fn packet(pipe: &mut std::fs::File, header: &[u8], body: &[u8]) -> io::Result<()> {
    pipe.write_all(&((header.len() + body.len()) as u32).to_le_bytes())?;
    pipe.write_all(header)?;
    pipe.write_all(body)
}

pub fn run(parent_pid: u32, nonce: &str) -> io::Result<()> {
    let session = broker::session_of(std::process::id())?;
    let parent = Handle::new(unsafe { OpenProcess(0x00100000, 0, parent_pid) })?;
    if broker::session_of(parent_pid)? != session || !eligible(session) {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let mut pipe = broker::open_app(parent_pid, nonce)?;
    packet(&mut pipe, &[3], nonce.as_bytes())?;
    let consent = system_consent_path()?;
    let mut attached = None;
    let mut automation = None;
    let mut apartment = None;
    let mut prompt: Option<Prompt> = None;
    let mut generation = 0u32;
    let mut state = 255u8;
    let mut frame_ready = false;
    let mut last_click = Instant::now();
    let mut capture: Option<Capture> = None;
    let mut retry_capture = Instant::now();
    let mut next_frame = Instant::now();
    let mut policy_check = Instant::now();

    while broker::running(&parent) && unlocked(session) {
        let now = Instant::now();
        if now >= policy_check {
            if !eligible(session) {
                break;
            }
            policy_check = now + Duration::from_secs(1);
        }
        let input = input_desktop();
        let on_secure = input
            .as_ref()
            .is_some_and(|(_, n)| n.eq_ignore_ascii_case("Winlogon"));
        let on_normal = input
            .as_ref()
            .is_some_and(|(_, n)| n.eq_ignore_ascii_case("Default"));
        if on_secure && attached.is_none() {
            if let Some((desktop, _)) =
                input.filter(|(desktop, _)| unsafe { SetThreadDesktop(desktop.0) } != 0)
            {
                attached = Some(desktop);
                if let Ok((com, client)) = Automation::new() {
                    apartment = Some(com);
                    automation = Some(client);
                }
            }
        }
        let visible = if on_secure && attached.is_some() {
            current_prompt(&consent)
        } else {
            None
        };
        if prompt != visible {
            generation = generation.wrapping_add(1);
            prompt = visible;
            capture = None;
            frame_ready = false;
            retry_capture = now;
            if state == 1 {
                packet(&mut pipe, &[1], &[])?;
            }
        }
        let next_state = if on_normal { 0 } else { 1 };
        if state != next_state {
            state = next_state;
            packet(&mut pipe, &[state], &[])?;
        }

        if let (Some(prompt), Some(automation)) = (prompt, &automation) {
            if capture.is_none() && now >= retry_capture {
                capture = Capture::new(prompt.rect).ok();
                retry_capture = now + Duration::from_millis(500);
            }
            if now >= next_frame {
                next_frame = now + Duration::from_millis(200);
                if let Some(reader) = capture.as_mut() {
                    match reader.frame() {
                        Ok(Some((w, h, bytes)))
                            if current_prompt(&consent) == Some(prompt) && unlocked(session) =>
                        {
                            if !automation.can_share(prompt.window) {
                                if frame_ready {
                                    packet(&mut pipe, &[1], &[])?;
                                }
                                frame_ready = false;
                                continue;
                            }
                            let mut header = [2; 9];
                            header[1..5].copy_from_slice(&generation.to_le_bytes());
                            header[5..7].copy_from_slice(&w.to_le_bytes());
                            header[7..9].copy_from_slice(&h.to_le_bytes());
                            packet(&mut pipe, &header, bytes)?;
                            frame_ready = true;
                        }
                        Err(_) => {
                            capture = None;
                            frame_ready = false;
                            packet(&mut pipe, &[1], &[])?;
                        }
                        _ => {}
                    }
                }
            }
        }

        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                pipe.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        } == 0
        {
            break;
        }
        if available > 256 {
            break;
        }
        for _ in 0..available / 8 {
            let mut command = [0; 8];
            pipe.read_exact(&mut command)?;
            let target = u32::from_le_bytes(command[..4].try_into().unwrap());
            if frame_ready
                && target == generation
                && now.duration_since(last_click) >= Duration::from_millis(350)
                && eligible(session)
                && input_desktop().is_some_and(|(_, n)| n.eq_ignore_ascii_case("Winlogon"))
            {
                if let Some(prompt) = prompt.filter(|p| {
                    current_prompt(&consent) == Some(*p)
                        && automation.as_ref().is_some_and(|a| a.can_share(p.window))
                }) {
                    last_click = now;
                    click(
                        prompt,
                        u16::from_le_bytes([command[4], command[5]]),
                        u16::from_le_bytes([command[6], command[7]]),
                    );
                }
            }
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    drop(automation);
    drop(apartment);
    drop(attached);
    Ok(())
}
