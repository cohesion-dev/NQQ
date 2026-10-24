import type { GameSnapshot } from '../game/engine';

/** 全屏语音应用的页面状态控制，不渲染任何操作按钮。 */
export class UiController {
  private readonly panel: HTMLElement;
  private readonly conversation: HTMLElement;
  private mode: 'chat' | 'apple-game' = 'chat';
  private showText = true;

  /** 创建全屏场景上方的数字和文字图层。 */
  constructor(root: HTMLElement) {
    const shell = root.querySelector<HTMLElement>('.app-shell')!;
    this.panel = document.createElement('section');
    this.panel.className = 'hud';
    this.panel.innerHTML = '<div class="game-numbers" aria-live="polite"><strong data-time>180</strong><strong data-score>0</strong></div>';
    shell.append(this.panel);
    this.conversation = document.createElement('div');
    this.conversation.className = 'conversation';
    this.conversation.setAttribute('aria-live', 'polite');
    shell.append(this.conversation);
    this.showChat();
  }

  /** 切换聊天和游戏模式，不创建按钮或文字操作控件。 */
  setMode(mode: 'chat' | 'apple-game'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'chat') this.showChat(); else this.showGame();
  }

  /** 更新游戏数字；聊天模式隐藏游戏数字。 */
  render(snapshot: GameSnapshot): void {
    this.panel.classList.toggle('is-game', this.mode === 'apple-game');
    if (this.mode === 'apple-game') {
      this.panel.querySelector<HTMLElement>('[data-time]')!.textContent = String(Math.ceil(snapshot.remainingMs / 1000));
      this.panel.querySelector<HTMLElement>('[data-score]')!.textContent = String(snapshot.score);
    }
  }

  /** 展示字幕记录，最多保留最近 100 条。 */
  say(text: string, role = '七七'): void {
    if (!this.showText) return;
    const message = document.createElement('p');
    message.textContent = `${role}：${text}`;
    this.conversation.append(message);
    while (this.conversation.children.length > 100) this.conversation.firstElementChild?.remove();
    this.conversation.scrollTop = this.conversation.scrollHeight;
  }

  /** 显示连接或权限错误文字，不提供重试按钮。 */
  notice(text: string): void { this.say(text, '提示'); }

  /** 隐藏聊天文字时同时隐藏游戏字幕记录，但不删除已保存节点。 */
  setTextVisible(visible: boolean): void {
    this.showText = visible;
    this.conversation.classList.toggle('is-hidden', !visible);
  }

  /** 聊天模式没有 HUD 文案和控制按钮。 */
  private showChat(): void {
    this.panel.classList.remove('is-game');
    this.panel.replaceChildren();
  }

  /** 游戏模式只显示数字：上方为倒计时，下方为分数。 */
  private showGame(): void {
    this.panel.innerHTML = '<div class="game-numbers" aria-live="polite"><strong data-time>180</strong><strong data-score>0</strong></div>';
    this.panel.classList.add('is-game');
  }
}
