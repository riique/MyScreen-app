//! Injeção de mouse e teclado para o controle remoto (`SendInput`).
//!
//! Roda no utility process "input". Quem decide se um evento entra é o
//! processo principal: aqui só chegam comandos já validados, em pixels físicos
//! da área de trabalho virtual. O injetor guarda o que está pressionado para
//! poder soltar tudo quando a sessão acaba — tecla presa é o pior defeito
//! possível de um controle remoto.

use std::collections::HashSet;

/// Marca de todo INPUT nosso ("MYSC"), para um hook de baixo nível saber o
/// que veio do controle remoto e o que veio do teclado de verdade.
pub const EXTRA_INFO: usize = 0x4D59_5343;

/// Bit de tecla estendida no scancode do protocolo (prefixo E0).
pub const EXTENDED_BIT: u16 = 0x100;

/// Coordenada absoluta do `SendInput` (0..65535) sobre a área virtual. Mira o
/// CENTRO do pixel: o Windows volta para pixel com `n * size / 65536` truncado,
/// e mirar a borda esquerda caía um pixel antes em boa parte da tela.
pub fn normalize_virtual(p: i32, origin: i32, size: i32) -> i32 {
    if size <= 1 {
        return 0;
    }
    let size = size as i64;
    let offset = (p as i64 - origin as i64).clamp(0, size - 1);
    let n = ((2 * offset + 1) * 65536) / (2 * size);
    n.clamp(0, 65535) as i32
}

pub const KEY_SCANCODE: u32 = 0x0008;
pub const KEY_EXTENDED: u32 = 0x0001;
pub const KEY_UP: u32 = 0x0002;
pub const KEY_UNICODE: u32 = 0x0004;

/// Scancode do protocolo → (`wScan`, `dwFlags`) do `KEYBDINPUT`.
pub fn key_event(scancode: u16, down: bool) -> (u16, u32) {
    let mut flags = KEY_SCANCODE;
    if scancode & EXTENDED_BIT != 0 {
        flags |= KEY_EXTENDED;
    }
    if !down {
        flags |= KEY_UP;
    }
    (scancode & 0xFF, flags)
}

pub const M_LEFTDOWN: u32 = 0x0002;
pub const M_LEFTUP: u32 = 0x0004;
pub const M_RIGHTDOWN: u32 = 0x0008;
pub const M_RIGHTUP: u32 = 0x0010;
pub const M_MIDDLEDOWN: u32 = 0x0020;
pub const M_MIDDLEUP: u32 = 0x0040;
pub const M_XDOWN: u32 = 0x0080;
pub const M_XUP: u32 = 0x0100;

/// Botão do protocolo (0 esq, 1 meio, 2 dir, 3 voltar, 4 avançar) →
/// (`dwFlags`, `mouseData`). None para botão desconhecido.
pub fn button_event(button: u8, down: bool) -> Option<(u32, u32)> {
    Some(match (button, down) {
        (0, true) => (M_LEFTDOWN, 0),
        (0, false) => (M_LEFTUP, 0),
        (1, true) => (M_MIDDLEDOWN, 0),
        (1, false) => (M_MIDDLEUP, 0),
        (2, true) => (M_RIGHTDOWN, 0),
        (2, false) => (M_RIGHTUP, 0),
        (3, true) => (M_XDOWN, 1),
        (3, false) => (M_XUP, 1),
        (4, true) => (M_XDOWN, 2),
        (4, false) => (M_XUP, 2),
        _ => return None,
    })
}

/// Um passo de "Enviar texto": caractere Unicode (unidade UTF-16) ou tecla
/// física para o que aplicativo nenhum aceita como Unicode (Enter, Tab).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TextStep {
    Unit(u16),
    Scancode(u16),
}

/// Divide o texto em passos. `\r\n` e `\r` viram um Enter só; pares
/// surrogate saem como duas unidades seguidas (o Windows remonta).
pub fn text_steps(s: &str) -> Vec<TextStep> {
    let mut out = Vec::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push(TextStep::Scancode(0x1C));
            }
            '\n' => out.push(TextStep::Scancode(0x1C)),
            '\t' => out.push(TextStep::Scancode(0x0F)),
            c if c.is_control() => {}
            c => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push(TextStep::Unit(*unit));
                }
            }
        }
    }
    out
}

/// O que o hook de teclado faz com uma tecla física de quem controla.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum HookKey {
    /// Vai para o PC remoto com este scancode do protocolo.
    Forward(u16),
    /// Engolida sem ir a lugar nenhum (shift falso do driver, Ctrl falso do AltGr).
    Drop,
}

const LLKHF_EXTENDED: u32 = 0x01;

/// `KBDLLHOOKSTRUCT` → scancode do protocolo. Corrige as esquisitices do
/// hook de baixo nível: o Shift direito vem marcado como estendido; o AltGr
/// manda um Ctrl esquerdo falso (scanCode 0x21D), que o Windows do outro lado
/// gera sozinho; Print Screen e as setas com Num Lock vêm com Shift falso (E0 2A).
pub fn hook_key(scan_code: u32, flags: u32) -> HookKey {
    if scan_code & 0x200 != 0 {
        return HookKey::Drop;
    }
    let sc = (scan_code & 0xFF) as u16;
    if sc == 0 {
        return HookKey::Drop;
    }
    let extended = flags & LLKHF_EXTENDED != 0;
    match (sc, extended) {
        (0x2A, true) => HookKey::Drop,
        (0x36, true) => HookKey::Forward(0x36),
        (_, true) => HookKey::Forward(sc | EXTENDED_BIT),
        (_, false) => HookKey::Forward(sc),
    }
}

/// O que está pressionado agora, para `release_all`.
#[derive(Default)]
pub struct Pressed {
    pub keys: HashSet<u16>,
    pub buttons: u8,
}

impl Pressed {
    pub fn key(&mut self, scancode: u16, down: bool) {
        if down {
            self.keys.insert(scancode);
        } else {
            self.keys.remove(&scancode);
        }
    }
    pub fn button(&mut self, button: u8, down: bool) {
        if button > 4 {
            return;
        }
        if down {
            self.buttons |= 1 << button;
        } else {
            self.buttons &= !(1 << button);
        }
    }
    /// Esvazia e devolve o que precisa ser solto (teclas em ordem estável).
    pub fn drain(&mut self) -> (Vec<u16>, Vec<u8>) {
        let mut keys: Vec<u16> = self.keys.drain().collect();
        keys.sort_unstable();
        let buttons = (0..5u8).filter(|b| self.buttons & (1 << b) != 0).collect();
        self.buttons = 0;
        (keys, buttons)
    }
}

#[cfg(windows)]
pub mod sys {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
        MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    };
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, WindowFromPoint, GA_ROOT,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    fn mouse(dx: i32, dy: i32, data: u32, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO },
            },
        }
    }

    fn keyboard(scan: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO },
            },
        }
    }

    /// Movimento absoluto para o pixel físico (px, py) da área virtual.
    pub fn move_input(px: i32, py: i32) -> INPUT {
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        mouse(
            normalize_virtual(px, vx, vw),
            normalize_virtual(py, vy, vh),
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        )
    }

    pub fn button_input(flags: u32, data: u32) -> INPUT {
        mouse(0, 0, data, flags)
    }

    pub fn wheel_inputs(dx: i32, dy: i32) -> Vec<INPUT> {
        let mut out = Vec::new();
        if dy != 0 {
            out.push(mouse(0, 0, dy as u32, MOUSEEVENTF_WHEEL));
        }
        if dx != 0 {
            out.push(mouse(0, 0, dx as u32, MOUSEEVENTF_HWHEEL));
        }
        out
    }

    pub fn key_input(scancode: u16, down: bool) -> INPUT {
        let (scan, flags) = key_event(scancode, down);
        keyboard(scan, flags)
    }

    pub fn unicode_input(unit: u16, down: bool) -> INPUT {
        keyboard(unit, KEY_UNICODE | if down { 0 } else { KEY_UP })
    }

    /// Manda os eventos; devolve quantos o Windows aceitou.
    pub fn send(inputs: &[INPUT]) -> u32 {
        if inputs.is_empty() {
            return 0;
        }
        unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) }
    }

    fn token_elevated(process: HANDLE) -> Option<bool> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            );
            CloseHandle(token);
            if ok == 0 {
                None
            } else {
                Some(info.TokenIsElevated != 0)
            }
        }
    }

    pub fn self_elevated() -> bool {
        token_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false)
    }

    /// PID do dono da janela de topo que está DE FATO sob o pixel (px, py) —
    /// não a que só ocupa o retângulo por trás de outras. 0 se não há janela.
    pub fn window_pid_at(px: i32, py: i32) -> u32 {
        unsafe {
            let hwnd = WindowFromPoint(POINT { x: px, y: py });
            if hwnd.is_null() {
                return 0;
            }
            let root = GetAncestor(hwnd, GA_ROOT);
            let mut pid = 0u32;
            GetWindowThreadProcessId(if root.is_null() { hwnd } else { root }, &mut pid);
            pid
        }
    }

    /// PID da janela em primeiro plano e se o processo dela roda elevado
    /// (None quando o Windows não deixa saber).
    pub fn foreground() -> (u32, Option<bool>) {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return (0, None);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return (0, None);
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return (pid, None);
            }
            let elevated = token_elevated(process);
            CloseHandle(process);
            (pid, elevated)
        }
    }
}

/// Hook de teclado de baixo nível (lado de quem controla). Ligado e com uma
/// janela do próprio MyScreen em primeiro plano, toda tecla física —
/// inclusive Windows, Alt+Tab e os atalhos globais — é engolida aqui e
/// entregue ao `Sink`, para ir ao PC remoto. Fora disso, nada muda.
#[cfg(windows)]
pub mod hook {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, PostThreadMessageW,
        SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_UP, MSG,
        WH_KEYBOARD_LL, WM_QUIT,
    };

    pub type Sink = Box<dyn Fn(u16, bool) + Send + Sync>;

    static OWN_PID: AtomicU32 = AtomicU32::new(0);
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static THREAD: AtomicU32 = AtomicU32::new(0);
    static SINK: Mutex<Option<Sink>> = Mutex::new(None);
    /// Teclas cuja descida foi engolida: só a subida delas é engolida também.
    /// Uma tecla que já estava apertada antes do hook sobe normalmente aqui.
    static SWALLOWED: Mutex<Option<HashSet<u16>>> = Mutex::new(None);

    fn ours_in_front() -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            pid != 0 && pid == OWN_PID.load(Ordering::Relaxed)
        }
    }

    unsafe extern "system" fn proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 && ACTIVE.load(Ordering::Relaxed) {
            let info = &*(lparam as *const KBDLLHOOKSTRUCT);
            if info.flags & LLKHF_INJECTED == 0 {
                let down = info.flags & LLKHF_UP == 0;
                let key = hook_key(info.scanCode, info.flags);
                let id = match key {
                    HookKey::Forward(sc) => sc,
                    HookKey::Drop => 0x1000 | (info.scanCode as u16 & 0xFFF),
                };
                let swallow = {
                    let mut guard = SWALLOWED.lock().unwrap();
                    let set = guard.get_or_insert_with(HashSet::new);
                    if down {
                        let yes = ours_in_front();
                        if yes {
                            set.insert(id);
                        }
                        yes
                    } else {
                        set.remove(&id)
                    }
                };
                if swallow {
                    if let HookKey::Forward(sc) = key {
                        if let Some(sink) = SINK.lock().unwrap().as_ref() {
                            sink(sc, down);
                        }
                    }
                    return 1;
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /// Liga o hook numa thread própria (com laço de mensagens). Idempotente.
    pub fn start(own_pid: u32, sink: Sink) -> Result<(), String> {
        OWN_PID.store(own_pid, Ordering::Relaxed);
        *SINK.lock().unwrap() = Some(sink);
        ACTIVE.store(true, Ordering::SeqCst);
        if THREAD.load(Ordering::SeqCst) != 0 {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
        std::thread::Builder::new()
            .name("myscreen-keyhook".into())
            .spawn(move || unsafe {
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(proc), GetModuleHandleW(std::ptr::null()), 0);
                if hook.is_null() {
                    let _ = tx.send(Err("SetWindowsHookExW falhou".into()));
                    return;
                }
                let _ = tx.send(Ok(GetCurrentThreadId()));
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
                UnhookWindowsHookEx(hook);
            })
            .map_err(|e| e.to_string())?;
        match rx.recv() {
            Ok(Ok(id)) => {
                THREAD.store(id, Ordering::SeqCst);
                Ok(())
            }
            Ok(Err(e)) => {
                ACTIVE.store(false, Ordering::SeqCst);
                Err(e)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    /// Desliga e esquece o que estava engolido.
    pub fn stop() {
        ACTIVE.store(false, Ordering::SeqCst);
        *SINK.lock().unwrap() = None;
        *SWALLOWED.lock().unwrap() = None;
        let id = THREAD.swap(0, Ordering::SeqCst);
        if id != 0 {
            unsafe {
                PostThreadMessageW(id, WM_QUIT, 0, 0);
            }
        }
    }
}

/// Vigia do mouse físico (lado controlado). Um hook de mouse de baixo nível
/// que só observa — nunca engole nada — e avisa quando a dona do computador
/// mexe no mouse de verdade (evento não injetado). O portão usa isso para
/// devolver o mouse a ela na hora: quem está no PC tem prioridade.
#[cfg(windows)]
pub mod mousewatch {
    use super::EXTRA_INFO;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION,
        LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_MOUSEMOVE, WM_QUIT,
    };

    pub type Sink = Box<dyn Fn() + Send + Sync>;

    /// No máximo um aviso a cada isto: o portão só precisa saber que continua.
    const NOTIFY_EVERY_MS: u64 = 100;

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static THREAD: AtomicU32 = AtomicU32::new(0);
    static LAST_NOTIFY: AtomicU64 = AtomicU64::new(0);
    /// Última posição física vista (x << 32 | y): movimento sem deslocamento não conta.
    static LAST_PT: AtomicI64 = AtomicI64::new(i64::MIN);
    static SINK: Mutex<Option<Sink>> = Mutex::new(None);

    unsafe extern "system" fn proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 && ACTIVE.load(Ordering::Relaxed) {
            let info = &*(lparam as *const MSLLHOOKSTRUCT);
            let physical = info.flags & LLMHF_INJECTED == 0 && info.dwExtraInfo != EXTRA_INFO;
            if physical {
                let pt = ((info.pt.x as i64) << 32) | (info.pt.y as u32 as i64);
                let moved = LAST_PT.swap(pt, Ordering::Relaxed) != pt;
                if wparam as u32 != WM_MOUSEMOVE || moved {
                    let now = GetTickCount64();
                    let last = LAST_NOTIFY.load(Ordering::Relaxed);
                    if now.saturating_sub(last) >= NOTIFY_EVERY_MS {
                        LAST_NOTIFY.store(now, Ordering::Relaxed);
                        if let Some(sink) = SINK.lock().unwrap().as_ref() {
                            sink();
                        }
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /// Liga o vigia numa thread própria (com laço de mensagens). Idempotente.
    pub fn start(sink: Sink) -> Result<(), String> {
        *SINK.lock().unwrap() = Some(sink);
        LAST_PT.store(i64::MIN, Ordering::Relaxed);
        LAST_NOTIFY.store(0, Ordering::Relaxed);
        ACTIVE.store(true, Ordering::SeqCst);
        if THREAD.load(Ordering::SeqCst) != 0 {
            return Ok(());
        }
        let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
        std::thread::Builder::new()
            .name("myscreen-mousewatch".into())
            .spawn(move || unsafe {
                let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(proc), GetModuleHandleW(std::ptr::null()), 0);
                if hook.is_null() {
                    let _ = tx.send(Err("SetWindowsHookExW (mouse) falhou".into()));
                    return;
                }
                let _ = tx.send(Ok(GetCurrentThreadId()));
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
                UnhookWindowsHookEx(hook);
            })
            .map_err(|e| e.to_string())?;
        match rx.recv() {
            Ok(Ok(id)) => {
                THREAD.store(id, Ordering::SeqCst);
                Ok(())
            }
            Ok(Err(e)) => {
                ACTIVE.store(false, Ordering::SeqCst);
                Err(e)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn stop() {
        ACTIVE.store(false, Ordering::SeqCst);
        *SINK.lock().unwrap() = None;
        let id = THREAD.swap(0, Ordering::SeqCst);
        if id != 0 {
            unsafe {
                PostThreadMessageW(id, WM_QUIT, 0, 0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_corrige_as_esquisitices_do_windows() {
        assert_eq!(hook_key(0x1E, 0), HookKey::Forward(0x1E));
        // Seta para a esquerda e Windows: estendidas.
        assert_eq!(hook_key(0x4B, 1), HookKey::Forward(0x14B));
        assert_eq!(hook_key(0x5B, 1), HookKey::Forward(0x15B));
        // Shift direito vem marcado como estendido, mas não é.
        assert_eq!(hook_key(0x36, 1), HookKey::Forward(0x36));
        // Ctrl falso do AltGr e Shift falso do driver: engolidos, não enviados.
        assert_eq!(hook_key(0x21D, 0), HookKey::Drop);
        assert_eq!(hook_key(0x2A, 1), HookKey::Drop);
        assert_eq!(hook_key(0, 0), HookKey::Drop);
    }

    #[test]
    fn normaliza_cantos_da_area_virtual() {
        // Volta exatamente ao mesmo pixel, como o Windows converte.
        let back = |n: i32, origin: i32, size: i32| origin + ((n as i64 * size as i64) / 65536) as i32;
        for (origin, size) in [(0, 1920), (-1920, 3840), (0, 2560), (-1280, 4480), (0, 1366)] {
            for p in origin..origin + size {
                assert_eq!(back(normalize_virtual(p, origin, size), origin, size), p, "pixel {p} em {origin}+{size}");
            }
        }
        // Fora da área: preso na borda, nunca negativo.
        assert_eq!(back(normalize_virtual(-5000, -1920, 3840), -1920, 3840), -1920);
        assert_eq!(back(normalize_virtual(99999, 0, 1920), 0, 1920), 1919);
        assert_eq!(normalize_virtual(10, 0, 1), 0);
    }

    #[test]
    fn scancode_estendido_e_soltar() {
        assert_eq!(key_event(0x1E, true), (0x1E, KEY_SCANCODE));
        assert_eq!(key_event(0x1E, false), (0x1E, KEY_SCANCODE | KEY_UP));
        // Seta para a esquerda: E0 4B.
        assert_eq!(key_event(0x14B, true), (0x4B, KEY_SCANCODE | KEY_EXTENDED));
        assert_eq!(key_event(0x15B, false), (0x5B, KEY_SCANCODE | KEY_EXTENDED | KEY_UP));
    }

    #[test]
    fn botoes() {
        assert_eq!(button_event(0, true), Some((M_LEFTDOWN, 0)));
        assert_eq!(button_event(2, false), Some((M_RIGHTUP, 0)));
        assert_eq!(button_event(3, true), Some((M_XDOWN, 1)));
        assert_eq!(button_event(4, false), Some((M_XUP, 2)));
        assert_eq!(button_event(5, true), None);
    }

    #[test]
    fn texto_em_utf16_com_surrogates() {
        assert_eq!(text_steps("aé"), vec![TextStep::Unit(0x61), TextStep::Unit(0xE9)]);
        // 😀 = U+1F600 = D83D DE00
        assert_eq!(text_steps("😀"), vec![TextStep::Unit(0xD83D), TextStep::Unit(0xDE00)]);
        assert_eq!(
            text_steps("a\r\nb\nc\td\u{7}"),
            vec![
                TextStep::Unit(0x61),
                TextStep::Scancode(0x1C),
                TextStep::Unit(0x62),
                TextStep::Scancode(0x1C),
                TextStep::Unit(0x63),
                TextStep::Scancode(0x0F),
                TextStep::Unit(0x64),
            ]
        );
    }

    #[test]
    fn soltar_tudo_esvazia() {
        let mut p = Pressed::default();
        p.key(0x1D, true);
        p.key(0x1E, true);
        p.key(0x1E, false);
        p.key(0x14B, true);
        p.button(0, true);
        p.button(2, true);
        p.button(2, false);
        p.button(4, true);
        p.button(9, true);
        assert_eq!(p.drain(), (vec![0x1D, 0x14B], vec![0, 4]));
        assert_eq!(p.drain(), (vec![], vec![]));
    }
}
