/* Microphone blocks stay in memory; the processor has no network or storage access. */
class SoundCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) this.samples.push(sample);
      const size = Math.ceil(sampleRate * 1024 / 16000);
      if (this.samples.length >= size) {
        this.port.postMessage({ samples: this.samples.splice(0, size), sampleRate });
      }
    }
    return true;
  }
}
registerProcessor('sound-capture', SoundCapture);
