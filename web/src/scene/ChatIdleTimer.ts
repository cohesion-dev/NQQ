/** 只累计聊天模式中没有说话、没有动作的连续空闲时间。 */
export class ChatIdleTimer {
  private idleSince: number | null = null;

  /** 对话、指令或模式变化后，下一次空闲从零开始计时。 */
  reset(): void { this.idleSince = null; }

  /** 满十秒返回一次触发信号，表演结束后重新等待十秒。 */
  update(now: number, enabled: boolean, talking: boolean, busy: boolean): boolean {
    if (!enabled || talking || busy) {
      this.reset();
      return false;
    }
    this.idleSince ??= now;
    if (now - this.idleSince < 10_000) return false;
    this.reset();
    return true;
  }
}
