// AudioWorklet: decima para 16kHz, aplica filtro passa-baixa anti-aliasing e converte para PCM 16-bit mono.
class PCMDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.buffer = [];
    this.accumulator = 0;

    // Filtro IIR passa-baixa de 1 polo se a taxa de amostragem for superior a 16kHz
    // fc = 7000Hz (evita dobrar ruído acima de 8kHz na banda de 16kHz sem latência perceptível)
    if (sampleRate > 16000) {
      const dt = 1 / sampleRate;
      const rc = 1 / (2 * Math.PI * 7000);
      this.alpha = dt / (rc + dt);
    } else {
      this.alpha = 1;
    }
    this.lowpass = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      const s = input[i];
      if (this.alpha < 1) {
        this.lowpass += this.alpha * (s - this.lowpass);
      } else {
        this.lowpass = s;
      }

      this.accumulator += 1;
      if (this.accumulator >= this.ratio) {
        this.accumulator -= this.ratio;
        this.buffer.push(this.lowpass);
      }
    }

    // 320 amostras = 20ms a 16kHz (reduz piso de buffering de 100ms para 20ms)
    while (this.buffer.length >= 320) {
      const chunk = this.buffer.splice(0, 320);
      const pcm16 = Int16Array.from(chunk, (s) => (s < 0 ? s * 0x8000 : s * 0x7fff));
      const capturedAt = typeof Date !== 'undefined' ? Date.now() : (currentTime * 1000);
      this.port.postMessage({ pcm: pcm16.buffer, capturedAt }, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-downsampler', PCMDownsampler);

