import { OpusDecoder } from 'opus-decoder';
import { readAudioParams, type LinxAudioParams } from '../../../shared/audio';

/** 解码灵矽真实音频并按顺序播放，文字字幕不参与语音合成。 */
export class LinxAudio {
  private params: LinxAudioParams | null = null;
  private decoder: OpusDecoder<LinxAudioParams['sample_rate']> | null = null;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private samples = new Float32Array(256);
  private sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private generation = 0;
  private pending = 0;
  private active = false;
  private ended = false;
  private queue = Promise.resolve();

  /** 播放状态负责麦克风与空闲表演互斥，错误只报告可诊断的代码。 */
  constructor(private readonly onState: (active: boolean) => void, private readonly onError: (code: string) => void) {}

  /** 接收服务端实际输出参数，重连时取消旧语音。 */
  configure(value: unknown): void {
    this.stop();
    try { this.params = readAudioParams(value); }
    catch { this.params = null; this.onError('UNSUPPORTED_AUDIO_PARAMS'); }
  }

  /** 用户触摸页面时解锁系统音频，不增加额外的操作按钮。 */
  async unlock(): Promise<void> {
    const context = this.context ??= new AudioContext();
    if (!this.analyser) {
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = this.samples.length;
      this.analyser.connect(context.destination);
    }
    if (context.state === 'suspended') {
      const generation = this.generation;
      // 系统拦截自动播放时 resume 可能一直等待，提示用户触摸解锁。
      const notice = setTimeout(() => {
        if (generation === this.generation && context.state === 'suspended') this.onError('AUDIO_PLAYBACK_BLOCKED');
      }, 250);
      try { await context.resume(); } finally { clearTimeout(notice); }
    }
  }

  /** 新语音独立解码，等待期间也保持播放占用状态。 */
  start(): void {
    this.stop();
    if (!this.params) { this.onError('AUDIO_PARAMS_MISSING'); return; }
    this.active = true;
    this.onState(true);
    if (this.params.format === 'opus') {
      this.decoder = new OpusDecoder({ sampleRate: this.params.sample_rate, channels: 1 });
      // 提前处理初始化失败，避免无音频帧时出现未捕获拒绝。
      const generation = this.generation;
      void this.decoder.ready.catch(() => { if (generation === this.generation) this.fail('AUDIO_DECODER_FAILED'); });
    }
  }

  /** 串行等待解码器和播放上下文，取消代次可阻止旧异步任务重新出声。 */
  push(frame: ArrayBuffer): Promise<void> {
    if (!this.active || this.ended || !this.params) return Promise.resolve();
    const generation = this.generation;
    const params = this.params;
    const decoder = this.decoder;
    this.pending++;
    this.queue = this.queue.then(async () => {
      if (generation !== this.generation) return;
      await decoder?.ready;
      if (generation !== this.generation) return;
      let channels: Float32Array[];
      if (decoder) {
        const result = decoder.decodeFrame(new Uint8Array(frame));
        if (result.errors.length) throw new Error('AUDIO_DECODE_FAILED');
        channels = result.channelData;
      } else {
        if (frame.byteLength % 2) throw new Error('INVALID_PCM_FRAME');
        const input = new DataView(frame);
        const samples = new Float32Array(frame.byteLength / 2);
        for (let index = 0; index < samples.length; index++) samples[index] = input.getInt16(index * 2, true) / 32768;
        channels = [samples];
      }
      if (!channels[0].length) return;
      await this.unlock();
      if (generation !== this.generation) return;
      const context = this.context!;
      if (context.state !== 'running') throw new Error('AUDIO_PLAYBACK_BLOCKED');
      const buffer = context.createBuffer(1, channels[0].length, params.sample_rate);
      buffer.getChannelData(0).set(channels[0]);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser!);
      source.onended = () => {
        source.disconnect();
        this.sources.delete(source);
        if (generation === this.generation) this.complete();
      };
      // 首帧预留短缓冲，后续帧沿同一时间轴衔接以吸收网络抖动。
      const at = Math.max(context.currentTime + (this.sources.size ? 0 : 0.08), this.nextAt);
      this.sources.add(source);
      this.nextAt = at + buffer.duration;
      source.start(at);
    }).catch((error) => {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : 'AUDIO_PLAYBACK_FAILED');
    }).finally(() => {
      if (generation !== this.generation) return;
      this.pending--;
      this.complete();
    });
    return this.queue;
  }

  /** 正常 stop 等待解码和已排队声音播完，打断 stop 立即取消。 */
  finish(aborted = false): void {
    if (aborted) { this.stop(); return; }
    this.ended = true;
    this.complete();
  }

  /** 语音从开始事件到最后一帧播放结束期间均占用对话状态。 */
  get speaking(): boolean { return this.active; }

  /** 用真实输出采样的均方根振幅驱动嘴型，缓冲静音时保持闭嘴。 */
  get amplitude(): number {
    if (!this.active || !this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let power = 0;
    for (const sample of this.samples) power += sample * sample;
    return Math.min(1, Math.sqrt(power / this.samples.length) * 4);
  }

  /** 取消所有已调度声音，并使未完成解码结果失效。 */
  stop(): void {
    this.generation++;
    this.pending = 0;
    this.ended = false;
    this.queue = Promise.resolve();
    this.nextAt = 0;
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear();
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder) void decoder.ready.then(() => decoder.free()).catch(() => {});
    if (this.active) { this.active = false; this.onState(false); }
  }

  /** 只有流已结束、解码完成且声音全部播完后才恢复监听。 */
  private complete(): void {
    if (this.active && this.ended && !this.pending && !this.sources.size) this.stop();
  }

  /** 播放失败时停止当前轮次，避免监听永久停留在暂停状态。 */
  private fail(code: string): void { this.stop(); this.onError(code); }

  /** 离开页面时关闭音频设备并释放解码器。 */
  dispose(): void {
    this.stop();
    if (this.context) void this.context.close();
    this.context = undefined;
    this.analyser = undefined;
  }
}
