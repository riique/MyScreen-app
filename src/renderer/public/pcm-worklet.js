/**
 * Buffer circular no thread de áudio: recebe PCM s16 estéreo 48 kHz em pacotes
 * de 10 ms e toca numa MediaStreamDestination. Acumula ~50 ms antes de tocar;
 * se passar de ~200 ms, descarta o excesso para o som não ficar cada vez mais
 * atrasado em relação à tela. Mesmo worklet do site (companionAudio.ts), com
 * uma adição: a porta do processo de áudio pode chegar direto aqui
 * (`pcm-port`), sem passar pelo thread de interface.
 */
const TARGET = 2400, MAX = 9600, CAP = 48000;

class MyScreenPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = new Float32Array(CAP);
    this.r = new Float32Array(CAP);
    this.w = 0;
    this.rd = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === "pcm-port" && d.port) {
        d.port.onmessage = (m) => this.push(m.data);
        d.port.start();
        return;
      }
      this.push(d);
    };
  }

  push(data) {
    let s;
    if (data instanceof ArrayBuffer) s = new Int16Array(data);
    else if (ArrayBuffer.isView(data)) {
      // Cópia quando o deslocamento não é par: Int16Array exige alinhamento.
      s = data.byteOffset % 2 === 0
        ? new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1)
        : new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else return;
    for (let i = 0; i + 1 < s.length; i += 2) {
      const k = this.w % CAP;
      this.l[k] = s[i] / 32768;
      this.r[k] = s[i + 1] / 32768;
      this.w++;
    }
    if (this.w - this.rd > MAX) this.rd = this.w - TARGET;
  }

  process(_inputs, outputs) {
    const L = outputs[0][0], R = outputs[0][1] || L, n = L.length;
    const avail = this.w - this.rd;
    if (!this.playing && avail >= TARGET) this.playing = true;
    if (!this.playing || avail < n) {
      this.playing = false;
      L.fill(0);
      R.fill(0);
      return true;
    }
    for (let i = 0; i < n; i++) {
      const k = this.rd % CAP;
      L[i] = this.l[k];
      R[i] = this.r[k];
      this.rd++;
    }
    return true;
  }
}

registerProcessor("myscreen-pcm", MyScreenPcm);
