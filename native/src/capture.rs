//! Captura do som do sistema pelo loopback por processo do WASAPI.
//!
//! Vem do `companion/src/main.rs`. O que mudou: não há WebSocket nem lista de
//! clientes; quem consome é um único `Sink` (a ponte com o JavaScript), e o que
//! fica de fora ou dentro da captura é dado por PID, não por nome fixo.
//!
//! - `Exclude`: o sistema inteiro menos as árvores dadas (o próprio MyScreen,
//!   para a voz da chamada não voltar como eco; opcionalmente o Discord).
//! - `Include`: só a árvore de um processo (o dono da janela compartilhada).

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::dsp::{downmix, render_packet, Agc, CHANNELS, FRAMES_PER_PACKET, SAMPLE_RATE};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    Exclude,
    Include,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub mode: Mode,
    pub pids: Vec<u32>,
    /// Executáveis cujas árvores também ficam de fora (só em `Exclude`).
    pub exclude_names: Vec<String>,
}

/// Para onde vão os pacotes de 10 ms (s16le, estéreo, 48 kHz).
pub trait Sink: Send + Sync {
    fn packet(&self, bytes: Vec<u8>);
    fn error(&self, message: String);
}

pub struct Shared {
    pub config: Mutex<Config>,
    /// Ganho manual depois da normalização, em bits de f32 (1.0 = 100%).
    pub gain: AtomicU32,
    pub normalize: AtomicBool,
    pub agc: Mutex<Agc>,
    /// Ganho atual da normalização, em dB (bits de f32).
    pub agc_db: AtomicU32,
    /// Muda quando a configuração muda; a captura reinicia.
    pub generation: AtomicU64,
    /// Pico recente, em bits de f32, com decaimento.
    pub level: AtomicU32,
    pub running: AtomicBool,
    pub sink: Box<dyn Sink>,
}

impl Shared {
    pub fn new(config: Config, normalize: bool, gain: f32, sink: Box<dyn Sink>) -> Self {
        Self {
            config: Mutex::new(config),
            gain: AtomicU32::new(gain.to_bits()),
            normalize: AtomicBool::new(normalize),
            agc: Mutex::new(Agc::new()),
            agc_db: AtomicU32::new(0f32.to_bits()),
            generation: AtomicU64::new(0),
            level: AtomicU32::new(0),
            running: AtomicBool::new(true),
            sink,
        }
    }

    fn keep_going(&self, generation: u64) -> bool {
        self.running.load(Ordering::SeqCst) && self.generation.load(Ordering::SeqCst) == generation
    }

    fn emit(&self, samples: &mut [f32], peak_acc: &mut f32) {
        let gain = f32::from_bits(self.gain.load(Ordering::Relaxed));
        let (bytes, peak) = if self.normalize.load(Ordering::Relaxed) {
            let mut agc = self.agc.lock().unwrap();
            let r = render_packet(samples, Some(&mut agc), gain);
            self.agc_db.store(agc.gain_db.to_bits(), Ordering::Relaxed);
            r
        } else {
            render_packet(samples, None, gain)
        };
        *peak_acc = peak_acc.max(peak);
        self.sink.packet(bytes);
    }

    fn update_level(&self, peak: f32) {
        let prev = f32::from_bits(self.level.load(Ordering::Relaxed));
        self.level.store(peak.max(prev * 0.85).to_bits(), Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------- processos

fn process_table() -> sysinfo::System {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    System::new_with_specifics(RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()))
}

fn exe_name(sys: &sysinfo::System, pid: sysinfo::Pid) -> Option<String> {
    sys.process(pid).map(|p| p.name().to_string_lossy().to_lowercase())
}

/// Sobe a árvore enquanto o pai tem o mesmo executável: navegadores e o Discord
/// tocam som num processo filho, mas o loopback por processo pega a árvore
/// inteira a partir da raiz.
pub fn root_pid(sys: &sysinfo::System, pid: u32) -> u32 {
    let mut cur = sysinfo::Pid::from_u32(pid);
    let name = exe_name(sys, cur);
    if name.is_none() {
        return pid;
    }
    while let Some(parent) = sys.process(cur).and_then(|p| p.parent()) {
        if exe_name(sys, parent) != name {
            break;
        }
        cur = parent;
    }
    cur.as_u32()
}

/// Raízes de todos os processos com um dos nomes dados.
fn roots_named(sys: &sysinfo::System, names: &[String]) -> Vec<u32> {
    sys.processes()
        .iter()
        .filter(|(_, p)| {
            let n = p.name().to_string_lossy().to_lowercase();
            names.iter().any(|want| *want == n)
        })
        .map(|(pid, _)| root_pid(sys, pid.as_u32()))
        .collect()
}

pub fn root_of(pid: u32) -> u32 {
    root_pid(&process_table(), pid)
}

// ---------------------------------------------------------------- loopback

/// Uma captura de loopback por processo, já em estéreo 48 kHz f32.
struct Loopback {
    client: wasapi::AudioClient,
    capture: wasapi::AudioCaptureClient,
    event: wasapi::Handle,
    /// Canais pedidos ao Windows (os do dispositivo de saída).
    channels: usize,
    /// O que chegou do Windows, ainda em `channels` canais.
    raw: VecDeque<u8>,
    /// Já em estéreo f32.
    samples: VecDeque<f32>,
}

/// Canais do formato de mixagem da saída padrão (8 num fone 7.1).
fn device_channels() -> usize {
    wasapi::DeviceEnumerator::new()
        .and_then(|e| e.get_default_device(&wasapi::Direction::Render))
        .and_then(|d| d.get_iaudioclient())
        .and_then(|c| c.get_mixformat())
        .map(|f| f.get_nchannels() as usize)
        .unwrap_or(CHANNELS)
        .clamp(1, 8)
}

impl Loopback {
    fn open(pid: u32, include_tree: bool) -> Result<Self, String> {
        use wasapi::*;
        // Sem máscara de canais: com a máscara 7.1 o loopback por processo
        // entrega só silêncio; sem ela, os 8 canais chegam no nível certo.
        let channels = device_channels();
        let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, channels, None);
        let mut client = AudioClient::new_application_loopback_client(pid, include_tree)
            .map_err(|e| format!("loopback: {e}"))?;
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
        client
            .initialize_client(&format, &Direction::Capture, &mode)
            .map_err(|e| format!("initialize: {e}"))?;
        let event = client.set_get_eventhandle().map_err(|e| format!("event: {e}"))?;
        let capture = client.get_audiocaptureclient().map_err(|e| format!("capture: {e}"))?;
        client.start_stream().map_err(|e| format!("start: {e}"))?;
        Ok(Self { client, capture, event, channels, raw: VecDeque::new(), samples: VecDeque::new() })
    }

    /// Lê o que o Windows tiver; sem som tocando não chega nada (é normal).
    fn pull(&mut self) -> Result<(), String> {
        while self.capture.get_next_packet_size().ok().flatten().unwrap_or(0) > 0 {
            self.capture
                .read_from_device_to_deque(&mut self.raw)
                .map_err(|e| format!("read: {e}"))?;
        }
        let frame_bytes = self.channels * 4;
        let mut frame = [0f32; 8];
        while self.raw.len() >= frame_bytes {
            for v in frame.iter_mut().take(self.channels) {
                let b = [
                    self.raw.pop_front().unwrap(),
                    self.raw.pop_front().unwrap(),
                    self.raw.pop_front().unwrap(),
                    self.raw.pop_front().unwrap(),
                ];
                *v = f32::from_le_bytes(b);
            }
            let (l, r) = downmix(&frame[..self.channels]);
            self.samples.push_back(l);
            self.samples.push_back(r);
        }
        Ok(())
    }

    fn frames(&self) -> usize {
        self.samples.len() / CHANNELS
    }

    /// Soma `n` quadros em `mix` (faltando, completa com silêncio).
    fn mix_into(&mut self, mix: &mut [f32], n: usize) {
        let take = n.min(self.frames()) * CHANNELS;
        for (slot, v) in mix.iter_mut().zip(self.samples.drain(..take)) {
            *slot += v;
        }
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        let _ = self.client.stop_stream();
    }
}

// ---------------------------------------------------------------- estratégias

/// Uma captura só: o sistema menos uma árvore (`include_tree = false`) ou só
/// uma árvore (`include_tree = true`). Sem mixagem e sem atraso extra.
fn capture_single(shared: &Shared, generation: u64, pid: u32, include_tree: bool) -> Result<(), String> {
    let mut lb = Loopback::open(pid, include_tree)?;
    let mut buf = vec![0f32; FRAMES_PER_PACKET * CHANNELS];
    while shared.keep_going(generation) {
        let _ = lb.event.wait_for_event(100);
        lb.pull()?;
        let mut peak = 0f32;
        while lb.frames() >= FRAMES_PER_PACKET {
            buf.fill(0.0);
            lb.mix_into(&mut buf, FRAMES_PER_PACKET);
            shared.emit(&mut buf, &mut peak);
        }
        shared.update_level(peak);
    }
    Ok(())
}

/// Uma fonte da mistura: a captura de um programa roda na própria thread, porque
/// abrir o loopback de alguns apps leva segundos (o WhatsApp levou 4,7 s) e não
/// pode congelar as outras fontes. A thread só empurra amostras para a fila.
struct MixSource {
    queue: Arc<Mutex<VecDeque<f32>>>,
    stop: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    primed: bool,
}

impl MixSource {
    fn spawn(pid: u32, max_samples: usize) -> Self {
        let queue = Arc::new(Mutex::new(VecDeque::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let (q, st, f) = (queue.clone(), stop.clone(), failed.clone());
        thread::spawn(move || {
            let _ = wasapi::initialize_mta();
            let mut lb = match Loopback::open(pid, true) {
                Ok(lb) => lb,
                Err(_) => {
                    f.store(true, Ordering::SeqCst);
                    return;
                }
            };
            while !st.load(Ordering::SeqCst) {
                let _ = lb.event.wait_for_event(100);
                if lb.pull().is_err() {
                    f.store(true, Ordering::SeqCst);
                    return;
                }
                if lb.samples.is_empty() {
                    continue;
                }
                let mut q = q.lock().unwrap();
                q.extend(lb.samples.drain(..));
                // Fila longa demais = esta fonte adiantou; corta o excesso para o
                // atraso não crescer.
                if q.len() > max_samples {
                    let extra = q.len() - max_samples / 5;
                    q.drain(..extra);
                }
            }
        });
        Self { queue, stop, failed, primed: false }
    }
}

impl Drop for MixSource {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Duas ou mais árvores excluídas: o Windows só sabe excluir UMA por captura.
/// Então o caminho se inverte: uma captura por programa que tem sessão de som
/// (menos os excluídos), misturadas aqui num relógio de 10 ms.
fn capture_mixed(shared: &Shared, generation: u64, excluded_roots: &[u32]) -> Result<(), String> {
    const PACKET: usize = FRAMES_PER_PACKET * CHANNELS;
    // 20 ms de folga por fonte antes de entrar na mistura: absorve o jitter
    // entre o relógio do Windows e o desta thread.
    const PRIME: usize = PACKET * 2;
    const MAX_QUEUE: usize = PACKET * 10;

    let mut sources: HashMap<u32, MixSource> = HashMap::new();
    let mut failed: HashMap<u32, Instant> = HashMap::new();
    let mut last_scan = Instant::now() - Duration::from_secs(10);
    let mut next_emit = Instant::now();
    let mut buf = vec![0f32; PACKET];
    let me = std::process::id();

    while shared.keep_going(generation) {
        // A cada segundo: quem tem sessão de som agora? Um jogo aberto depois
        // entra na mistura em até 1 s.
        if last_scan.elapsed() >= Duration::from_secs(1) {
            last_scan = Instant::now();
            let sys = process_table();
            let mut wanted: Vec<u32> = Vec::new();
            if let Ok(dev) =
                wasapi::DeviceEnumerator::new().and_then(|e| e.get_default_device(&wasapi::Direction::Render))
            {
                if let Ok(sessions) = dev.get_iaudiosessionmanager().and_then(|m| m.get_audiosessionenumerator()) {
                    for i in 0..sessions.get_count().unwrap_or(0) {
                        let Ok(pid) = sessions.get_session(i).and_then(|c| c.get_process_id()) else {
                            continue;
                        };
                        if pid == 0 || pid == me {
                            continue;
                        }
                        let root = root_pid(&sys, pid);
                        if !excluded_roots.contains(&root) && !wanted.contains(&root) {
                            wanted.push(root);
                        }
                    }
                }
            }
            sources.retain(|pid, src| {
                let dead = src.failed.load(Ordering::SeqCst);
                if dead {
                    failed.insert(*pid, Instant::now());
                }
                !dead && wanted.contains(pid)
            });
            for pid in wanted {
                let recently_failed = failed.get(&pid).is_some_and(|t| t.elapsed() < Duration::from_secs(10));
                if !sources.contains_key(&pid) && !recently_failed {
                    sources.insert(pid, MixSource::spawn(pid, MAX_QUEUE));
                }
            }
        }

        let mut peak = 0f32;
        let now = Instant::now();
        if now.duration_since(next_emit) > Duration::from_millis(100) {
            next_emit = now; // a thread ficou parada; não tenta recuperar o atraso
        }
        while now >= next_emit {
            buf.fill(0.0);
            for src in sources.values_mut() {
                let mut q = src.queue.lock().unwrap();
                if !src.primed && q.len() >= PRIME {
                    src.primed = true;
                }
                if src.primed {
                    let take = PACKET.min(q.len());
                    if take < PACKET {
                        src.primed = false; // acabou o som: volta a esperar folga
                    }
                    for (slot, v) in buf.iter_mut().zip(q.drain(..take)) {
                        *slot += v;
                    }
                }
            }
            shared.emit(&mut buf, &mut peak);
            next_emit += Duration::from_millis(10);
        }
        shared.update_level(peak);
        thread::sleep(Duration::from_millis(3));
    }
    Ok(())
}

fn capture_session(shared: &Shared) -> Result<(), String> {
    let generation = shared.generation.load(Ordering::SeqCst);
    let config = shared.config.lock().unwrap().clone();
    let sys = process_table();
    match config.mode {
        Mode::Include => {
            let Some(&pid) = config.pids.first() else {
                return Err("nenhum processo para capturar".into());
            };
            capture_single(shared, generation, root_pid(&sys, pid), true)
        }
        Mode::Exclude => {
            let mut roots: Vec<u32> = config.pids.iter().map(|&p| root_pid(&sys, p)).collect();
            if !config.exclude_names.is_empty() {
                roots.extend(roots_named(&sys, &config.exclude_names));
            }
            roots.sort_unstable();
            roots.dedup();
            drop(sys);
            match roots.as_slice() {
                // Excluir só este processo = capturar o sistema inteiro.
                [] => capture_single(shared, generation, std::process::id(), false),
                [one] => capture_single(shared, generation, *one, false),
                many => capture_mixed(shared, generation, many),
            }
        }
    }
}

/// Laço da thread de captura. Uma falha vira aviso e nova tentativa em 2 s; a
/// configuração nova (geração) reinicia a captura sem derrubar a thread.
pub fn run(shared: Arc<Shared>) {
    let _ = wasapi::initialize_mta();
    let mut reported: Option<String> = None;
    while shared.running.load(Ordering::SeqCst) {
        match capture_session(&shared) {
            Ok(()) => reported = None,
            Err(e) => {
                if reported.as_deref() != Some(e.as_str()) {
                    shared.sink.error(e.clone());
                    reported = Some(e);
                }
                shared.level.store(0f32.to_bits(), Ordering::Relaxed);
                let until = Instant::now() + Duration::from_secs(2);
                while Instant::now() < until && shared.running.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}
