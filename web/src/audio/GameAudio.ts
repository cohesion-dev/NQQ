/** 仅生成抓取与疲惫音效，角色回复由灵矽真实语音播放器负责。 */
export class GameAudio {
  private context?: AudioContext;

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

  /** 离开页面时释放游戏音效资源。 */
  dispose(): void {
    if (this.context) void this.context.close();
    this.context = undefined;
  }
}
