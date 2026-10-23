export interface LinxMessage { type: string; [key: string]: any }

/** 连接自己的同源网关，页面不接触灵矽密钥或设备凭证。 */
export class LinxClient {
  private socket?: WebSocket;
  private roundId = '';
  private ready = false;

  /** 使用调用方事件处理器路由真实工具请求和字幕。 */
  constructor(private readonly onMessage: (message: LinxMessage) => void) {}

  /** 申请设备会话并等待灵矽握手与工具发现。 */
  async connect(): Promise<void> {
    this.close();
    const response = await fetch('/api/session', { method: 'POST' });
    if (!response.ok) throw new Error('SESSION_FAILED');
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/linx`);
      this.socket = socket;
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) return;
        const message = JSON.parse(event.data) as LinxMessage;
        if (message.type === 'ready') { this.ready = true; resolve(); }
        if (message.type === 'round') this.roundId = message.roundId;
        if (message.type === 'error' || message.type === 'activation') reject(new Error(message.type === 'activation' ? `ACTIVATION:${message.code}` : message.code));
        this.onMessage(message);
      });
      socket.addEventListener('error', () => reject(new Error('GATEWAY_UNAVAILABLE')));
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        this.ready = false;
        reject(new Error('LINX_DISCONNECTED'));
        this.onMessage({ type: 'disconnected' });
      });
    });
  }

  /** 请求服务端固定截止时间，收到 round 事件后才启动本地本局。 */
  startRound(): void { this.send({ type: 'start' }); }

  /** 发送与当前本局绑定的控制消息。 */
  send(message: LinxMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.ready) return;
    this.socket.send(JSON.stringify({ roundId: this.roundId, ...message }));
  }

  /** 上传分帧后的单声道未压缩音频。 */
  sendAudio(frame: ArrayBuffer): void {
    if (this.ready && this.roundId && this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
  }

  /** 主动关闭连接，旧连接的关闭事件不能覆盖新连接。 */
  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.roundId = '';
    socket?.close();
  }
}
