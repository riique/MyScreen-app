//! Addon nativo do MyScreen para Windows: som do sistema por loopback de
//! processo e injeção de mouse/teclado do controle remoto, expostos ao Node via
//! napi-rs. Cada parte roda no seu utility process ("audio" e "input"); se uma
//! travar ou cair, a sala continua.

pub mod capture;
pub mod dsp;
pub mod input;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::JoinHandle;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::capture::{Config, Mode, Shared, Sink};
use crate::dsp::{GAIN_MAX_PCT, GAIN_MIN_PCT};

#[napi(object)]
pub struct CaptureOptions {
    /// "exclude": o sistema menos as árvores de `pids`; "include": só a árvore
    /// do primeiro PID.
    pub mode: String,
    pub pids: Vec<u32>,
    /// Executáveis (minúsculos, com .exe) cujas árvores também ficam de fora.
    pub exclude_names: Option<Vec<String>>,
    /// Normalização de volume (padrão: ligada).
    pub normalize: Option<bool>,
    /// Volume enviado em %, 0–400 (padrão: 100).
    pub gain_pct: Option<f64>,
}

#[napi(object)]
pub struct CaptureUpdate {
    pub normalize: Option<bool>,
    pub gain_pct: Option<f64>,
}

fn parse_mode(mode: &str) -> Result<Mode> {
    match mode {
        "exclude" => Ok(Mode::Exclude),
        "include" => Ok(Mode::Include),
        _ => Err(Error::new(Status::InvalidArg, format!("modo invalido: {mode}"))),
    }
}

fn gain_from_pct(pct: Option<f64>) -> f32 {
    (pct.unwrap_or(100.0).clamp(GAIN_MIN_PCT, GAIN_MAX_PCT) / 100.0) as f32
}

// Fila curta: pacote que não couber é descartado (`QueueFull`), nunca
// acumulado. O som não pode ficar cada vez mais atrasado em relação à tela.
type PcmFn = ThreadsafeFunction<Buffer, (), Buffer, Status, false, false, 32>;
type ErrFn = ThreadsafeFunction<String, (), String, Status, false, false, 8>;

struct JsSink {
    pcm: PcmFn,
    err: ErrFn,
}

impl Sink for JsSink {
    fn packet(&self, bytes: Vec<u8>) {
        let _ = self.pcm.call(Buffer::from(bytes), ThreadsafeFunctionCallMode::NonBlocking);
    }
    fn error(&self, message: String) {
        let _ = self.err.call(message, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

#[napi]
pub struct SystemAudioCapture {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

#[napi]
impl SystemAudioCapture {
    /// Começa a capturar na hora. `onPcm` recebe pacotes de 10 ms (1.920 bytes,
    /// s16le estéreo 48 kHz); `onError` recebe a descrição de uma falha (a
    /// captura tenta de novo sozinha a cada 2 s).
    #[napi(constructor)]
    pub fn new(
        options: CaptureOptions,
        on_pcm: Function<Buffer, ()>,
        on_error: Function<String, ()>,
    ) -> Result<Self> {
        let mode = parse_mode(&options.mode)?;
        if mode == Mode::Include && options.pids.is_empty() {
            return Err(Error::new(Status::InvalidArg, "include precisa de um PID".to_string()));
        }
        let pcm: PcmFn = on_pcm
            .build_threadsafe_function::<Buffer>()
            .callee_handled::<false>()
            .max_queue_size::<32>()
            .build()?;
        let err: ErrFn = on_error
            .build_threadsafe_function::<String>()
            .callee_handled::<false>()
            .max_queue_size::<8>()
            .build()?;
        let config = Config {
            mode,
            pids: options.pids,
            exclude_names: options
                .exclude_names
                .unwrap_or_default()
                .into_iter()
                .map(|n| n.to_lowercase())
                .collect(),
        };
        let shared = Arc::new(Shared::new(
            config,
            options.normalize.unwrap_or(true),
            gain_from_pct(options.gain_pct),
            Box::new(JsSink { pcm, err }),
        ));
        let s = shared.clone();
        let thread = std::thread::Builder::new()
            .name("myscreen-audio".into())
            .spawn(move || capture::run(s))
            .map_err(|e| Error::from_reason(format!("thread: {e}")))?;
        Ok(Self { shared, thread: Some(thread) })
    }

    /// Normalização e volume mudam na hora, sem reiniciar a captura.
    #[napi]
    pub fn update(&self, update: CaptureUpdate) {
        if let Some(n) = update.normalize {
            self.shared.normalize.store(n, Ordering::Relaxed);
        }
        if update.gain_pct.is_some() {
            self.shared.gain.store(gain_from_pct(update.gain_pct).to_bits(), Ordering::Relaxed);
        }
    }

    /// Troca o que entra na captura (reinicia a captura).
    #[napi]
    pub fn retarget(&self, mode: String, pids: Vec<u32>, exclude_names: Option<Vec<String>>) -> Result<()> {
        let mode = parse_mode(&mode)?;
        *self.shared.config.lock().unwrap() = Config {
            mode,
            pids,
            exclude_names: exclude_names.unwrap_or_default().into_iter().map(|n| n.to_lowercase()).collect(),
        };
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// Pico recente (0–1), para o medidor da interface.
    #[napi]
    pub fn level(&self) -> f64 {
        f32::from_bits(self.shared.level.load(Ordering::Relaxed)) as f64
    }

    /// Ganho atual da normalização, em dB.
    #[napi]
    pub fn agc_db(&self) -> f64 {
        f32::from_bits(self.shared.agc_db.load(Ordering::Relaxed)) as f64
    }

    #[napi]
    pub fn stop(&mut self) {
        self.shared.running.store(false, Ordering::SeqCst);
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        self.shared.running.store(false, Ordering::SeqCst);
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// PID do processo dono de uma janela (`GetWindowThreadProcessId`). 0 se a
/// janela não existe mais.
#[napi]
pub fn pid_from_hwnd(hwnd: i64) -> u32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd as isize as _, &mut pid);
    }
    pid
}

/// Raiz da árvore de um processo (ancestral de mesmo executável).
#[napi]
pub fn root_pid(pid: u32) -> u32 {
    capture::root_of(pid)
}

// ---------------------------------------------------------------- controle remoto

#[napi(object)]
pub struct ForegroundInfo {
    pub pid: u32,
    /// None: o Windows não deixou saber (processo protegido ou de outro usuário).
    pub elevated: Option<bool>,
}

/// Injeta mouse e teclado (`SendInput`). Coordenadas em pixels físicos da área
/// de trabalho virtual — a conversão do quadro de vídeo para pixel é do
/// processo principal, que também decide se o evento pode entrar.
#[napi]
pub struct InputInjector {
    pressed: input::Pressed,
}

fn sent(n: u32, want: usize) -> Result<()> {
    if n as usize == want {
        Ok(())
    } else {
        Err(Error::from_reason(format!("SendInput aceitou {n} de {want}")))
    }
}

#[napi]
impl InputInjector {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { pressed: input::Pressed::default() }
    }

    #[napi]
    pub fn move_to(&self, px: i32, py: i32) -> Result<()> {
        sent(input::sys::send(&[input::sys::move_input(px, py)]), 1)
    }

    /// Move para (px, py) e aperta/solta o botão, num `SendInput` só.
    #[napi]
    pub fn button(&mut self, button: u8, down: bool, px: i32, py: i32) -> Result<()> {
        let (flags, data) = input::button_event(button, down)
            .ok_or_else(|| Error::new(Status::InvalidArg, format!("botao invalido: {button}")))?;
        self.pressed.button(button, down);
        sent(
            input::sys::send(&[input::sys::move_input(px, py), input::sys::button_input(flags, data)]),
            2,
        )
    }

    /// Roda em unidades de `WHEEL_DELTA` (120 por dente); dy positivo = para cima.
    #[napi]
    pub fn wheel(&self, dx: i32, dy: i32, px: i32, py: i32) -> Result<()> {
        let mut inputs = vec![input::sys::move_input(px, py)];
        inputs.extend(input::sys::wheel_inputs(dx, dy));
        let want = inputs.len();
        sent(input::sys::send(&inputs), want)
    }

    /// Tecla física por scancode (set 1; bit 0x100 = estendida).
    #[napi]
    pub fn key(&mut self, scancode: u16, down: bool) -> Result<()> {
        self.pressed.key(scancode, down);
        sent(input::sys::send(&[input::sys::key_input(scancode, down)]), 1)
    }

    /// Digita o texto caractere a caractere (`KEYEVENTF_UNICODE`): não depende
    /// do layout de teclado de nenhum dos lados.
    #[napi]
    pub fn text(&self, s: String) -> Result<()> {
        let mut inputs = Vec::new();
        for step in input::text_steps(&s) {
            match step {
                input::TextStep::Unit(u) => {
                    inputs.push(input::sys::unicode_input(u, true));
                    inputs.push(input::sys::unicode_input(u, false));
                }
                input::TextStep::Scancode(sc) => {
                    inputs.push(input::sys::key_input(sc, true));
                    inputs.push(input::sys::key_input(sc, false));
                }
            }
        }
        let want = inputs.len();
        sent(input::sys::send(&inputs), want)
    }

    /// Solta toda tecla e botão que o controle remoto deixou apertado.
    #[napi]
    pub fn release_all(&mut self) -> Result<()> {
        let (keys, buttons) = self.pressed.drain();
        let mut inputs = Vec::new();
        for sc in keys {
            inputs.push(input::sys::key_input(sc, false));
        }
        for b in buttons {
            if let Some((flags, data)) = input::button_event(b, false) {
                inputs.push(input::sys::button_input(flags, data));
            }
        }
        let want = inputs.len();
        if want == 0 {
            return Ok(());
        }
        sent(input::sys::send(&inputs), want)
    }

    #[napi]
    pub fn foreground(&self) -> ForegroundInfo {
        let (pid, elevated) = input::sys::foreground();
        ForegroundInfo { pid, elevated }
    }

    /// PID do dono da janela visível sob o pixel (zona protegida exata).
    #[napi]
    pub fn window_pid_at(&self, px: i32, py: i32) -> u32 {
        input::sys::window_pid_at(px, py)
    }

    /// O próprio MyScreen roda como administrador? (Aí o UIPI não bloqueia.)
    #[napi]
    pub fn self_elevated(&self) -> bool {
        input::sys::self_elevated()
    }
}

type KeyFn = ThreadsafeFunction<u32, (), u32, Status, false, false, 256>;

/// Liga o hook de teclado de quem controla. `onKey` recebe
/// `scancode | (down << 16)` para cada tecla engolida. Só engole com uma
/// janela do processo `ownPid` (o MyScreen) em primeiro plano.
#[napi]
pub fn start_keyboard_hook(own_pid: u32, on_key: Function<u32, ()>) -> Result<()> {
    let tsfn: KeyFn = on_key
        .build_threadsafe_function::<u32>()
        .callee_handled::<false>()
        .max_queue_size::<256>()
        .build()?;
    input::hook::start(
        own_pid,
        Box::new(move |sc, down| {
            let _ = tsfn.call(sc as u32 | if down { 1 << 16 } else { 0 }, ThreadsafeFunctionCallMode::NonBlocking);
        }),
    )
    .map_err(Error::from_reason)
}

#[napi]
pub fn stop_keyboard_hook() {
    input::hook::stop();
}
