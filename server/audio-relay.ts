import { readAudioParams } from '../shared/audio.ts';

/** 转发真实语音的参数、状态和原始帧，取消后丢弃残留音频。 */
export class LinxAudioRelay {
  private active = false;

  /** 控制消息与音频分别发送，保留音频包边界和二进制内容。 */
  constructor(
    private readonly send: (message: Record<string, unknown>) => void,
    private readonly sendFrame: (frame: Uint8Array) => void,
  ) {}

  /** 从握手响应提取下行参数，不复用麦克风的上传格式。 */
  configure(params: unknown): void {
    this.send({ type: 'audio.config', params: readAudioParams(params) });
  }

  /** 正常结束保留已转发帧，打断则通知页面立即清空缓冲。 */
  handle(message: Record<string, unknown>): void {
    if (message.type !== 'tts') return;
    if (message.state === 'start') {
      this.active = true;
      this.send({ type: 'audio.start' });
    } else if (message.state === 'stop') {
      this.active = false;
      this.send({ type: 'audio.stop', aborted: message.is_aborted === true });
    }
  }

  /** 只有当前语音轮次中的音频才能抵达播放器。 */
  push(frame: Uint8Array): void {
    if (this.active) this.sendFrame(frame);
  }

  /** 用户开始新一轮输入时取消旧语音，阻止迟到帧继续播放。 */
  cancel(): void {
    this.active = false;
    this.send({ type: 'audio.stop', aborted: true });
  }
}
