export interface RecorderOptions {
  /** 连续检测到语音后开始当前语音轮次。 */
  onSpeechStart: () => void;
  /** 连续静音达到阈值后结束当前语音轮次。 */
  onSpeechStop: () => void;
  /** 每个 20 毫秒 PCM（脉冲编码调制）帧回传给网关。 */
  onFrame: (frame: ArrayBuffer) => void;
}

/** 浏览器麦克风采集器，内置基于音量阈值的 VAD（语音活动检测）。 */
export class PcmRecorder {
  private context?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private gate = 0;
  private recording = false;
  private speechActive = false;
  private paused = false;

  /** 申请麦克风并开始持续采集；通话期间不因一句话结束而释放设备。 */
  async start(options: RecorderOptions): Promise<void> {
    this.stop();
    const gate = ++this.gate;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (gate !== this.gate) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    try {
      const context = new AudioContext();
      this.context = context;
      await context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      if (gate !== this.gate) return;
      await context.resume();
      if (gate !== this.gate) return;
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'nqq-pcm');
      this.node = node; this.source = source;
      node.port.onmessage = (event) => {
        if (gate !== this.gate) return;
        const payload = event.data as { pcm: ArrayBuffer; speech: boolean };
        if (!this.paused && payload.speech && !this.speechActive) {
          this.speechActive = true;
          options.onSpeechStart();
        }
        if (!this.paused && !payload.speech && this.speechActive) {
          this.speechActive = false;
          options.onSpeechStop();
        }
        if (!this.paused) options.onFrame(payload.pcm);
      };
      this.recording = true;
      source.connect(node).connect(context.destination);
    } catch (error) { this.stop(); throw error; }
  }

  /** 回复播放期间暂停 VAD 和上传，避免把牛七七自己的声音再次识别。 */
  pause(): void { this.paused = true; this.speechActive = false; }

  /** 恢复 VAD，下一次检测到声音时开始新轮次。 */
  resume(): void { this.paused = false; }

  /** 返回当前语音轮次是否已经检测到说话。 */
  get isSpeechActive(): boolean { return this.speechActive; }

  /** 停止并释放麦克风；返回是否建立过采集设备。 */
  stop(): boolean {
    this.gate++;
    const wasRecording = this.recording;
    this.recording = false;
    this.paused = false;
    this.speechActive = false;
    this.node?.disconnect(); this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context) void this.context.close();
    this.node = undefined; this.source = undefined; this.stream = undefined; this.context = undefined;
    return wasRecording;
  }
}
