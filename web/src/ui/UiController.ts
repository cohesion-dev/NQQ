import type { GameSnapshot } from '../game/engine';

export interface UiActions {
  start: (seconds: number) => Promise<void>;
  voiceStart: () => void;
  voiceStop: () => void;
}

/** 页面只提交意图和展示快照，不自行计算得分或执行游戏规则。 */
export class UiController {
  private readonly panel: HTMLElement;
  private readonly speech: HTMLElement;
  private readonly status: HTMLElement;
  private readonly score: HTMLElement;
  private readonly time: HTMLElement;
  private phase = '';
  private seconds = 10;
  private voiceReady = false;
  private busy = false;
  private holding = false;
  private readonly conversation: HTMLElement;

  /** 创建稳定的界面节点，语音操作与场景共用手机可见区域。 */
  constructor(root: HTMLElement, private readonly actions: UiActions) {
    const shell = root.querySelector<HTMLElement>('.app-shell')!;
    const header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML = '<div><p class="eyebrow">VOICE · APPLE HUNT</p><h1>牛七七</h1><p class="subtitle">你来导航，我来抓。</p></div><div class="stat-row"><div class="stat"><span class="stat-label">口袋里的苹果</span><strong class="stat-value" data-score>0</strong></div><div class="stat"><span class="stat-label">剩余时间</span><strong class="stat-value" data-time>60s</strong></div></div>';
    shell.prepend(header);
    this.score = header.querySelector('[data-score]')!;
    this.time = header.querySelector('[data-time]')!;
    const stage = shell.querySelector<HTMLElement>('.stage')!;
    this.status = document.createElement('div'); this.status.className = 'status-pill';
    this.speech = document.createElement('div'); this.speech.className = 'speech';
    this.speech.textContent = '嗨，我是牛七七。准备好当我的导航了吗？';
    this.speech.setAttribute('aria-live', 'polite');
    stage.append(this.status, this.speech);
    this.panel = document.createElement('section'); this.panel.className = 'bottom-panel';
    this.conversation = document.createElement('div'); this.conversation.className = 'conversation';
    this.conversation.setAttribute('aria-label', '最近对话');
    shell.append(this.panel, this.conversation);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.endHold(); });
    window.addEventListener('blur', () => this.endHold());
  }

  /** 更新规则值，仅在页面阶段变化时重建控制区域。 */
  render(snapshot: GameSnapshot): void {
    this.score.textContent = String(snapshot.score);
    this.time.textContent = `${snapshot.phase === 'ready' ? 60 : Math.ceil(snapshot.remainingMs / 1000)}s`;
    this.status.textContent = snapshot.phase === 'running'
      ? `语音挑战 · ${snapshot.fatigued ? '呼哧呼哧，还能抓！' : '蒙眼挑战中'}`
      : snapshot.phase === 'finished' ? '挑战完成' : '程序化模型 · 本地声音';
    if (snapshot.phase === this.phase) return;
    this.endHold(); this.phase = snapshot.phase;
    if (snapshot.phase === 'ready') this.showReady();
    if (snapshot.phase === 'running') this.showControls();
    if (snapshot.phase === 'finished') this.showResult(snapshot.score);
  }

  /** 展示角色回复，并保留最近的几条对话。 */
  say(text: string, role = '七七'): void {
    if (role === '七七') this.speech.textContent = text;
    const message = document.createElement('p'); message.textContent = `${role}：${text}`;
    this.conversation.prepend(message);
    while (this.conversation.children.length > 2) this.conversation.lastElementChild?.remove();
  }

  /** 显示服务或权限提示，不把错误伪装成角色完成动作。 */
  notice(text: string): void {
    this.say(text, '提示');
    const element = this.panel.querySelector<HTMLElement>('[data-notice]');
    if (element) element.textContent = text;
  }

  /** 根据实际连接与录音状态更新麦克风，断线时禁止继续发起采音。 */
  setVoiceState(state: 'ready' | 'requesting' | 'recording' | 'unavailable'): void {
    this.voiceReady = state !== 'unavailable';
    if (!this.voiceReady) this.endHold();
    const talk = this.panel.querySelector<HTMLButtonElement>('[data-talk]');
    if (!talk) return;
    talk.disabled = !this.voiceReady;
    talk.dataset.state = state;
    talk.setAttribute('aria-pressed', String(state === 'recording'));
    talk.textContent = { ready: '按住和七七说话', requesting: '请允许麦克风…', recording: '正在听，松开发送', unavailable: '连接已断开' }[state];
  }

  /** 展示就绪页，游戏配置只在开局时读取。 */
  private showReady(): void {
    this.panel.innerHTML = `<div class="setup"><div><span class="mini-label">准备挑战</span><h2>一分钟，能装满口袋吗？</h2><p>只用声音告诉我：向左、向前、转圈圈。</p></div><label class="config-label">苹果停留时间<input type="number" min="0.1" step="0.1" value="${this.seconds}" data-lifetime aria-label="苹果停留秒数"><span>秒</span></label></div><button class="control primary" data-start>连接七七，开始挑战 →</button><p class="hint" data-notice>开局后按住说话，松开发送。说“停下”就能停止动作。</p>`;
    this.panel.querySelector<HTMLButtonElement>('[data-start]')!.addEventListener('click', () => void this.begin());
  }

  /** 校验寿命并防止连接期间重复开局。 */
  private async begin(): Promise<void> {
    if (this.busy) return;
    const input = this.panel.querySelector<HTMLInputElement>('[data-lifetime]');
    const seconds = input ? Number(input.value) : this.seconds;
    if (!Number.isFinite(seconds) || seconds <= 0) return this.notice('苹果停留时间必须是大于 0 的秒数。');
    this.seconds = seconds;
    this.busy = true;
    const button = this.panel.querySelector<HTMLButtonElement>('[data-start]')!;
    button.disabled = true; button.textContent = '正在连接七七…';
    try { await this.actions.start(seconds); }
    catch (error) {
      this.notice(error instanceof Error ? error.message : '连接失败，请重试。');
      button.disabled = false; button.textContent = '重试连接';
    } finally { this.busy = false; }
  }

  /** 游戏期间只提供麦克风入口，动作必须由语音经灵矽触发。 */
  private showControls(): void {
    this.panel.innerHTML = '<button class="control talk" data-talk aria-pressed="false">按住和七七说话</button><p class="hint" data-notice>说“向左两步”“向前走”或“停下”，也可以问我问题。</p>';
    const talk = this.panel.querySelector<HTMLButtonElement>('[data-talk]')!;
    this.setVoiceState(this.voiceReady ? 'ready' : 'unavailable');
    talk.addEventListener('pointerdown', (event) => {
      if (!this.voiceReady || this.holding) return;
      event.preventDefault(); talk.setPointerCapture(event.pointerId); this.holding = true;
      this.setVoiceState('requesting'); this.actions.voiceStart();
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) talk.addEventListener(event, () => this.endHold());
    talk.addEventListener('keydown', (event) => {
      if (![' ', 'Enter'].includes(event.key) || event.repeat || !this.voiceReady || this.holding) return;
      event.preventDefault(); this.holding = true; this.setVoiceState('requesting'); this.actions.voiceStart();
    });
    talk.addEventListener('keyup', (event) => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); this.endHold(); } });
    talk.addEventListener('blur', () => this.endHold());
  }

  /** 松手或页面离开时只结束一次录音。 */
  private endHold(): void {
    if (!this.holding) return;
    this.holding = false; this.actions.voiceStop();
    const talk = this.panel.querySelector<HTMLButtonElement>('[data-talk]');
    if (talk) this.setVoiceState(this.voiceReady ? 'ready' : 'unavailable');
  }

  /** 结算只读取引擎分数，重新开始先返回可配置的准备页。 */
  private showResult(score: number): void {
    this.panel.innerHTML = `<div class="result"><span class="mini-label">口袋清点完毕</span><h2>${score} 个苹果</h2><p>导航辛苦了！本牛宣布，合作愉快。</p><button class="control primary" data-ready>再挑战一次 →</button></div>`;
    this.panel.querySelector('[data-ready]')!.addEventListener('click', () => this.showReady());
  }
}
