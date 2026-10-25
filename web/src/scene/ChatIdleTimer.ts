/** 累计聊天静默时间，自动动作之间连续衔接。 */
export class ChatIdleTimer {
  private idleSince: number | null = null;
  private wasAutomatic = false;
  private nextDanceAt = 0;

  /** 对话、指令或模式变化后，下一次空闲从零开始计时。 */
  reset(): void {
    this.idleSince = null;
    this.wasAutomatic = false;
    this.nextDanceAt = 0;
  }

  /** 静默满三秒开始动作，自动动作结束后暂停半秒再触发下一支。 */
  update(now: number, enabled: boolean, talking: boolean, busy: boolean, automatic = false): boolean {
    if (!enabled || talking || (busy && !automatic)) {
      this.reset();
      return false;
    }
    this.idleSince ??= now;
    if (this.wasAutomatic && !automatic) this.nextDanceAt = now + 500;
    this.wasAutomatic = automatic;
    return !busy && now - this.idleSince >= 3_000 && now >= this.nextDanceAt;
  }
}
