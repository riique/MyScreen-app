//! Addon nativo do MyScreen para Windows: som do sistema por loopback de
//! processo, exposto ao Node via napi-rs. Roda dentro do utility process
//! "audio" do Electron; se travar ou cair, a sala continua.

pub mod capture;
pub mod dsp;

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
