/** 把浏览器实际采样率转换为 16kHz 单声道，按 20 毫秒上传。 */
export class PcmRecorder {
  private context?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private gate = 0;
  private recording = false;

  /** 用户开始按住时申请设备，取消期间获得的设备立即释放。 */
  async start(onStart: () => void, onFrame: (frame: ArrayBuffer) => void): Promise<void> {
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
      node.port.onmessage = (event) => { if (gate === this.gate) onFrame(event.data); };
      onStart(); this.recording = true;
      source.connect(node).connect(context.destination);
    } catch (error) { this.stop(); throw error; }
  }

  /** 停止后丢弃不足一帧的尾部并释放麦克风；返回是否实际开始过监听。 */
  stop(): boolean {
    this.gate++;
    const wasRecording = this.recording;
    this.recording = false;
    this.node?.disconnect(); this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context) void this.context.close();
    this.node = undefined; this.source = undefined; this.stream = undefined; this.context = undefined;
    return wasRecording;
  }
}
