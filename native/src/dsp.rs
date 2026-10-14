//! Processamento do som capturado: normalização, limitador, mistura para
//! estéreo e empacotamento em PCM s16. Vem do `companion/` sem mudança de
//! comportamento, separado aqui para ser testado sem Windows nem Node.

pub const SAMPLE_RATE: usize = 48_000;
pub const CHANNELS: usize = 2;
/// 10 ms por pacote: latência baixa sem afogar a ponte até o renderer.
pub const FRAMES_PER_PACKET: usize = SAMPLE_RATE / 100;
/// Bytes de um pacote em s16 estéreo (1.920).
pub const PACKET_BYTES: usize = FRAMES_PER_PACKET * CHANNELS * 2;

pub const GAIN_MIN_PCT: f64 = 0.0;
pub const GAIN_MAX_PCT: f64 = 400.0;

/// Normalização automática de volume.
///
/// Mede a intensidade (RMS) numa janela de ~300 ms e ajusta o ganho para levar
/// o som a -16 dBFS RMS — nível de plataforma de streaming. Desce rápido
/// (80 ms, para uma explosão não estourar) e sobe devagar (1,5 s, para não
/// "respirar" entre uma frase e outra). Em silêncio segura o ganho: não sobe o
/// chiado de fundo até virar ruído.
pub struct Agc {
    env: f32,
    pub gain_db: f32,
}

impl Default for Agc {
    fn default() -> Self {
        Self::new()
    }
}

impl Agc {
    pub const TARGET_DB: f32 = -16.0;
    pub const MIN_DB: f32 = -6.0;
    pub const MAX_DB: f32 = 24.0;
    const SILENCE: f32 = 1e-6; // -60 dBFS de energia média

    pub fn new() -> Self {
        Self { env: 0.0, gain_db: 0.0 }
    }

    pub fn process(&mut self, block: &mut [f32]) {
        if block.is_empty() {
            return;
        }
        let block_ms = (block.len() / CHANNELS) as f32 * 1000.0 / SAMPLE_RATE as f32;
        let ms = block.iter().map(|v| v * v).sum::<f32>() / block.len() as f32;
        let a = (-block_ms / 300.0).exp();
        self.env = self.env * a + ms * (1.0 - a);

        let old = self.gain_db;
        if self.env > Self::SILENCE {
            let loud_db = 10.0 * self.env.log10();
            let want = (Self::TARGET_DB - loud_db).clamp(Self::MIN_DB, Self::MAX_DB);
            let tau = if want < old { 80.0 } else { 1500.0 };
            let c = (-block_ms / tau).exp();
            self.gain_db = old * c + want * (1.0 - c);
        }

        // Interpola o ganho dentro do bloco: sem degrau a cada 10 ms (zíper).
        let (g0, g1) = (db_to_lin(old), db_to_lin(self.gain_db));
        let frames = block.len() / CHANNELS;
        for (i, frame) in block.chunks_exact_mut(CHANNELS).enumerate() {
            let g = g0 + (g1 - g0) * (i as f32 + 1.0) / frames as f32;
            for v in frame {
                *v *= g;
            }
        }
    }
}

pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Limitador suave: abaixo de 0.8 passa intacto; acima, curva até no máximo
/// 1.0. Deixa subir o volume sem o estalo de corte nos picos (explosões, bumbo).
pub fn soft_limit(x: f32) -> f32 {
    const KNEE: f32 = 0.8;
    let a = x.abs();
    if a <= KNEE {
        x
    } else {
        x.signum() * (KNEE + (1.0 - KNEE) * ((a - KNEE) / (1.0 - KNEE)).tanh())
    }
}

/// Mistura um quadro de N canais para estéreo, sem perder volume.
///
/// Pedir estéreo direto ao Windows numa saída 7.1 custa ~14 dB: a conversão
/// dele divide o sinal entre os 8 canais para nunca estourar. Música e jogo
/// estéreo vivem em FL/FR, então eles passam inteiros; centro e laterais entram
/// a -3 dB, LFE fica de fora. O limitador no envio segura o que somar acima de
/// 0 dBFS. Ordem WAVE: FL FR FC LFE BL BR SL SR.
pub fn downmix(f: &[f32]) -> (f32, f32) {
    const H: f32 = std::f32::consts::FRAC_1_SQRT_2;
    match f.len() {
        0 => (0.0, 0.0),
        1 => (f[0], f[0]),
        2..=4 => (f[0], f[1]),
        6 => (f[0] + H * (f[2] + f[4]), f[1] + H * (f[2] + f[5])),
        8 => (f[0] + H * (f[2] + f[4] + f[6]), f[1] + H * (f[2] + f[5] + f[7])),
        _ => (f[0], f[1]),
    }
}

/// Aplica normalização (se ligada), ganho manual e limitador, e empacota em
/// s16le intercalado. Devolve o pacote e o pico (0..1) para o medidor.
pub fn render_packet(block: &mut [f32], agc: Option<&mut Agc>, gain: f32) -> (Vec<u8>, f32) {
    if let Some(agc) = agc {
        agc.process(block);
    }
    let mut peak = 0f32;
    let mut out = Vec::with_capacity(block.len() * 2);
    for &v in block.iter() {
        let v = soft_limit(v * gain);
        peak = peak.max(v.abs());
        out.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
    }
    (out, peak)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(amp: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                let v = amp * (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / SAMPLE_RATE as f32).sin();
                [v, v]
            })
            .collect()
    }

    fn rms_db(block: &[f32]) -> f32 {
        let ms = block.iter().map(|v| v * v).sum::<f32>() / block.len() as f32;
        10.0 * ms.log10()
    }

    #[test]
    fn agc_converges_to_target() {
        let mut agc = Agc::new();
        let mut last = Vec::new();
        // 10 s de um tom baixo (-36 dBFS RMS aprox.).
        for _ in 0..1000 {
            let mut block = tone(0.02, FRAMES_PER_PACKET);
            agc.process(&mut block);
            last = block;
        }
        let db = rms_db(&last);
        assert!((db - Agc::TARGET_DB).abs() < 1.5, "chegou a {db} dBFS");
    }

    #[test]
    fn agc_holds_gain_in_silence() {
        let mut agc = Agc::new();
        for _ in 0..500 {
            let mut block = tone(0.05, FRAMES_PER_PACKET);
            agc.process(&mut block);
        }
        // O envelope (janela de 300 ms) leva um instante para cair abaixo do
        // limiar de silêncio; depois disso o ganho fica parado.
        for _ in 0..300 {
            let mut block = vec![0f32; FRAMES_PER_PACKET * CHANNELS];
            agc.process(&mut block);
        }
        let before = agc.gain_db;
        for _ in 0..1000 {
            let mut block = vec![0f32; FRAMES_PER_PACKET * CHANNELS];
            agc.process(&mut block);
        }
        assert!((agc.gain_db - before).abs() < 0.01, "{before} -> {}", agc.gain_db);
    }

    #[test]
    fn agc_respects_limits() {
        let mut agc = Agc::new();
        for _ in 0..2000 {
            let mut block = tone(0.0005, FRAMES_PER_PACKET);
            agc.process(&mut block);
        }
        assert!(agc.gain_db <= Agc::MAX_DB + 0.01);
        let mut agc = Agc::new();
        for _ in 0..2000 {
            let mut block = tone(1.0, FRAMES_PER_PACKET);
            agc.process(&mut block);
        }
        assert!(agc.gain_db >= Agc::MIN_DB - 0.01);
    }

    #[test]
    fn soft_limit_never_exceeds_one() {
        for i in -1000..=1000 {
            let x = i as f32 / 50.0; // -20 .. 20
            let y = soft_limit(x);
            assert!(y.abs() <= 1.0, "{x} -> {y}");
            assert_eq!(y.signum(), if x == 0.0 { y.signum() } else { x.signum() });
        }
        assert_eq!(soft_limit(0.5), 0.5);
        assert_eq!(soft_limit(-0.8), -0.8);
    }

    #[test]
    fn downmix_keeps_front_and_folds_surround() {
        assert_eq!(downmix(&[0.3, -0.2]), (0.3, -0.2));
        assert_eq!(downmix(&[0.4]), (0.4, 0.4));
        let h = std::f32::consts::FRAC_1_SQRT_2;
        // 5.1: FL FR FC LFE BL BR — LFE fica de fora.
        let (l, r) = downmix(&[0.1, 0.2, 0.3, 0.9, 0.4, 0.5]);
        assert!((l - (0.1 + h * (0.3 + 0.4))).abs() < 1e-6);
        assert!((r - (0.2 + h * (0.3 + 0.5))).abs() < 1e-6);
        // 7.1: só o FL tocando = esquerda inteira, direita muda.
        let (l, r) = downmix(&[0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!((l, r), (0.5, 0.0));
        let (l, r) = downmix(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.4]);
        assert!((l - h * 0.2).abs() < 1e-6 && (r - h * 0.4).abs() < 1e-6);
    }

    #[test]
    fn packet_is_10ms_of_s16_stereo() {
        assert_eq!(PACKET_BYTES, 1920);
        let mut block = vec![0.5f32; FRAMES_PER_PACKET * CHANNELS];
        let (bytes, peak) = render_packet(&mut block, None, 1.0);
        assert_eq!(bytes.len(), PACKET_BYTES);
        assert!((peak - 0.5).abs() < 1e-6);
        let first = i16::from_le_bytes([bytes[0], bytes[1]]);
        assert_eq!(first, (0.5f32 * 32767.0) as i16);
    }

    #[test]
    fn gain_is_limited_softly() {
        let mut block = vec![0.6f32; FRAMES_PER_PACKET * CHANNELS];
        let (_, peak) = render_packet(&mut block, None, 4.0);
        assert!(peak <= 1.0 && peak > 0.9);
    }
}
