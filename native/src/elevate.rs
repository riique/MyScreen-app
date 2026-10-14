//! Acesso a janelas de administrador no PC controlado. O Windows (UIPI)
//! descarta o input que um processo comum manda a uma janela elevada; então,
//! quando a pessoa controlada aceita o UAC, o MyScreen sobe um auxiliar
//! elevado que só faz o `SendInput`. Ele lê os comandos de um pipe nomeado
//! criado pelo processo principal — e só depois de conferir que quem serve o
//! pipe é DE FATO aquele processo (PID recebido na linha de comando).

#[cfg(windows)]
pub mod sys {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_CANCELLED, ERROR_PIPE_BUSY, GENERIC_READ, HANDLE, HWND,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, ReadFile, OPEN_EXISTING};
    use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    /// Roda `exe args` como administrador (pede o UAC, dono `hwnd`).
    /// Ok(false): a pessoa recusou.
    pub fn run_as_admin(exe: &str, args: &str, hwnd: isize) -> Result<bool, String> {
        let verb = wide("runas");
        let file = wide(exe);
        let params = wide(args);
        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_NOASYNC;
            info.hwnd = hwnd as HWND;
            info.lpVerb = verb.as_ptr();
            info.lpFile = file.as_ptr();
            info.lpParameters = params.as_ptr();
            info.nShow = SW_HIDE;
            if ShellExecuteExW(&mut info) != 0 {
                return Ok(true);
            }
            match GetLastError() {
                ERROR_CANCELLED => Ok(false),
                code => Err(format!("ShellExecuteExW falhou ({code})")),
            }
        }
    }

    pub struct Pipe(HANDLE);
    unsafe impl Send for Pipe {}

    impl Drop for Pipe {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Pipe {
        /// Abre o pipe para leitura e recusa se o servidor não for `server_pid`.
        pub fn open(path: &str, server_pid: u32) -> Result<Pipe, String> {
            let name = wide(path);
            let mut tries = 0;
            let handle = loop {
                let h = unsafe {
                    CreateFileW(name.as_ptr(), GENERIC_READ, 0, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut())
                };
                if h != INVALID_HANDLE_VALUE {
                    break h;
                }
                let code = unsafe { GetLastError() };
                tries += 1;
                if code != ERROR_PIPE_BUSY || tries > 5 {
                    return Err(format!("não abriu o pipe ({code})"));
                }
                unsafe { WaitNamedPipeW(name.as_ptr(), 2000) };
            };
            let pipe = Pipe(handle);
            let mut pid = 0u32;
            if unsafe { GetNamedPipeServerProcessId(pipe.0, &mut pid) } == 0 || pid != server_pid {
                return Err(format!("o pipe não é do MyScreen (servidor {pid}, esperado {server_pid})"));
            }
            Ok(pipe)
        }

        /// Lê até `buf.len()` bytes; 0 = o outro lado fechou.
        pub fn read(&self, buf: &mut [u8]) -> usize {
            let mut n = 0u32;
            let ok = unsafe { ReadFile(self.0, buf.as_mut_ptr(), buf.len() as u32, &mut n, std::ptr::null_mut()) };
            if ok == 0 {
                0
            } else {
                n as usize
            }
        }
    }

    /// Lê linhas do pipe até ele fechar, entregando cada uma (sem o `\n`).
    pub fn read_lines(pipe: Pipe, mut on_line: impl FnMut(String)) {
        let mut buf = vec![0u8; 64 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = pipe.read(&mut buf);
            if n == 0 {
                return;
            }
            pending.extend_from_slice(&buf[..n]);
            while let Some(i) = pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = pending.drain(..=i).collect();
                let text = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
                if !text.is_empty() {
                    on_line(text);
                }
            }
            // Uma linha sem fim de 1 MB não é comando nosso.
            if pending.len() > 1 << 20 {
                return;
            }
        }
    }
}
