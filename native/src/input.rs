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

/// Coordenada absoluta do `SendInput` (0..65535) sobre a área virtual.
pub fn normalize_virtual(p: i32, origin: i32, size: i32) -> i32 {
    if size <= 1 {
        return 0;
    }
    let n = ((p as i64 - origin as i64) * 65535) / (size as i64 - 1);
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
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_cantos_da_area_virtual() {
        assert_eq!(normalize_virtual(0, 0, 1920), 0);
        assert_eq!(normalize_virtual(1919, 0, 1920), 65535);
        // Monitor à esquerda do principal: origem negativa.
        assert_eq!(normalize_virtual(-1920, -1920, 3840), 0);
        assert_eq!(normalize_virtual(1919, -1920, 3840), 65535);
        // Fora da área: preso na borda, nunca negativo.
        assert_eq!(normalize_virtual(-5000, -1920, 3840), 0);
        assert_eq!(normalize_virtual(99999, 0, 1920), 65535);
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
