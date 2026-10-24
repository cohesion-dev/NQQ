/** 使用跨块的累计采样窗口降采样，避免每个输入块各自取整造成漂移。 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.weight = 0;
    this.sum = 0;
    this.frame = new Int16Array(320);
    this.index = 0;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.active = false;
    this.startLimit = Math.ceil(sampleRate * 0.04 / 128);
    this.silenceLimit = Math.ceil(sampleRate * 0.7 / 128);
  }

  /** 输出保持静音，只把麦克风转换后的字节发送到主线程。 */
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let energy = 0;
    for (const value of input) energy += value * value;
    const rms = Math.sqrt(energy / input.length);
    const speaking = rms >= 0.018;
    if (speaking) { this.speechFrames += 1; this.silenceFrames = 0; }
    else { this.silenceFrames += 1; this.speechFrames = 0; }
    if (this.speechFrames >= this.startLimit) this.active = true;
    if (this.silenceFrames >= this.silenceLimit) this.active = false;
    const speechState = this.active;
    for (const value of input) {
      let remaining = 1;
      while (remaining > 0.000001) {
        const weight = Math.min(remaining, this.ratio - this.weight);
        this.sum += value * weight;
        this.weight += weight;
        remaining -= weight;
        if (this.weight >= this.ratio - 0.000001) {
          const sample = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.index++] = sample < 0 ? sample * 32768 : sample * 32767;
          this.sum = 0; this.weight = 0;
          if (this.index === 320) {
            this.port.postMessage({ pcm: this.frame.buffer, speech: speechState }, [this.frame.buffer]);
            this.frame = new Int16Array(320); this.index = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('nqq-pcm', PcmProcessor);
