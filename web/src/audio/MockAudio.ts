/** 使用浏览器语音合成模拟灵矽语音，真实音频链路接通后替换本类。 */
export class MockAudio {
  private current: SpeechSynthesisUtterance | null = null;
  private context?: AudioContext;

  /** 本地嘴型只使用模拟朗读状态，不宣称取得真实语音振幅。 */
  get speaking(): boolean { return this.current !== null && window.speechSynthesis?.speaking; }

  /** 播放本地模拟语音，并在播放前停止上一段回复。 */
  speak(text: string, interrupt = true, onEnd: () => void = () => {}): void {
    if (interrupt) this.stop();
    if (!('speechSynthesis' in window)) { onEnd(); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.08;
    utterance.pitch = 1.1;
    utterance.onend = () => { if (this.current === utterance) this.current = null; onEnd(); };
    utterance.onerror = () => { if (this.current === utterance) this.current = null; onEnd(); };
    this.current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  /** 停止当前模拟语音。 */
  stop(): void {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.current = null;
  }

  /** 播放不依赖外部文件的短音效。 */
  effect(kind: 'grab' | 'expire' | 'tired' | 'finish'): void {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = this.context ??= new AudioContextCtor();
    if (context.state === 'suspended') void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const frequencies = { grab: 620, expire: 180, tired: 110, finish: 440 };
    oscillator.frequency.value = frequencies[kind];
    oscillator.type = kind === 'tired' ? 'sawtooth' : 'sine';
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (kind === 'finish' ? 0.28 : 0.14));
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.3);
    oscillator.addEventListener('ended', () => { oscillator.disconnect(); gain.disconnect(); });
  }

  /** 离开页面时释放模拟声音资源。 */
  dispose(): void {
    this.stop();
    if (this.context) void this.context.close();
    this.context = undefined;
  }
}
