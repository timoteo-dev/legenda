// AudioWorklet: decima para 16kHz e converte para PCM 16-bit mono.
class PCMDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.buffer = [];
    this.accumulator = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.accumulator += 1;
      if (this.accumulator >= this.ratio) {
        this.accumulator -= this.ratio;
        this.buffer.push(input[i]);
      }
    }

    while (this.buffer.length >= 1600) {
      const chunk = this.buffer.splice(0, 1600);
      const pcm16 = Int16Array.from(chunk, (s) => (s < 0 ? s * 0x8000 : s * 0x7fff));
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-downsampler', PCMDownsampler);
