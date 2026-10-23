import {
  ActionName,
  ActionResult,
  AppleState,
  DEFAULT_GAME_CONFIG,
  GameConfig,
  GameEngineOptions,
  GameEvent,
  GameEventListener,
  GamePhase,
  GameSnapshot,
  Position,
} from './types';

interface PendingRespawn {
  dueAt: number;
}

interface PendingAction {
  action: ActionName;
  steps: number;
  resolve: (result: ActionResult) => void;
  startedAt: number | null;
  dueAt: number | null;
  stepStart: Position;
  stepTarget: Position;
  stepsCompleted: number;
  touchedBoundary: boolean;
  collected: number;
}

interface TimelineEvent {
  at: number;
  kind: 'expire' | 'respawn' | 'collect' | 'action';
  appleId?: string;
  respawn?: PendingRespawn;
}

/**
 * 牛七七的纯规则引擎。
 * 所有时间都由 tick 驱动，渲染、语音和灵矽只消费快照与事件。
 */
export class GameEngine {
  private readonly config: GameConfig;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly initialPosition: Position;
  private readonly listeners = new Set<GameEventListener>();
  private readonly apples = new Map<string, AppleState>();
  private readonly respawns: PendingRespawn[] = [];
  private readonly queue: PendingAction[] = [];
  private position: Position;
  private phase: GamePhase = 'ready';
  private score = 0;
  private movementCount = 0;
  private fatigued = false;
  private fatigueUntil: number | null = null;
  private idleSince: number | null = null;
  private roundAppleLifespanMs: number;
  private currentAction: PendingAction | null = null;
  private startedAt: number | null = null;
  private endsAt: number | null = null;
  private lastTime: number;
  private eventSequence = 0;
  private appleSequence = 0;
  private lastPublishedTime = Number.NaN;

  /** 创建引擎并合并默认规则，随机数和时钟均可注入以便测试。 */
  public constructor(options: GameEngineOptions = {}) {
    this.config = this.mergeConfig(options.config);
    this.roundAppleLifespanMs = this.config.appleLifespanMs;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.initialPosition = this.clampPosition(options.initialPosition ?? { x: 0, z: 0 });
    this.position = { ...this.initialPosition };
    this.lastTime = this.now();
  }

  /** 订阅规则事件，返回取消订阅函数。 */
  public subscribe(listener: GameEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 开始新的一局；运行中的局不会被重复开始。 */
  public start(lifespanMs: number = this.config.appleLifespanMs, deadline?: number): void {
    this.assertPositiveFinite(lifespanMs, 'apple lifespan');
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= this.now())) throw new Error('invalid round deadline');
    if (this.phase === 'running') return;
    this.resetRound();
    const at = this.now();
    this.lastTime = at;
    this.startedAt = at;
    this.endsAt = deadline === undefined ? at + this.config.gameDurationMs : Math.min(deadline, at + this.config.gameDurationMs);
    this.roundAppleLifespanMs = lifespanMs;
    this.phase = 'running';
    for (let i = 0; i < this.config.maxApples; i += 1) this.spawnApple(at, lifespanMs);
    this.emit('game_started', at, { endsAt: this.endsAt, appleLifespanMs: lifespanMs });
  }

  /** 返回当前快照，数组和坐标均为副本，调用方不能修改引擎内部状态。 */
  public snapshot(): GameSnapshot {
    const remainingMs = this.phase === 'running' && this.endsAt !== null
      ? Math.max(0, this.endsAt - this.lastTime)
      : 0;
    return {
      phase: this.phase,
      score: this.score,
      remainingMs,
      apples: [...this.apples.values()].map((apple) => ({
        ...apple,
        position: { ...apple.position },
      })),
      position: { ...this.position },
      fatigued: this.fatigued,
      movementCount: this.movementCount,
      currentAction: this.currentAction?.action ?? null,
      queuedActions: this.queue.length,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
    };
  }

  /** 推进逻辑时间，处理苹果、疲惫和动作事件，时间倒退会被忽略。 */
  public tick(at: number = this.now()): void {
    if (!Number.isFinite(at)) throw new Error('time must be finite');
    if (at < this.lastTime) return;
    if (this.phase !== 'running') {
      this.lastTime = at;
      return;
    }
    if (this.endsAt !== null && at >= this.endsAt) {
      this.processUntil(this.endsAt, false);
      this.lastTime = this.endsAt;
      this.finish(this.endsAt);
      return;
    }
    this.processUntil(at, true);
    this.lastTime = at;
    if (this.lastPublishedTime !== at) this.publish([]);
  }

  /** update 是 tick 的语义别名，方便页面动画循环调用。 */
  public update(at: number = this.now()): void {
    this.tick(at);
  }

  /** 请求动作；动作按 FIFO（先进先出）排队并在后续 tick 中完成。 */
  public requestAction(action: ActionName, steps = 1): Promise<ActionResult> {
    const at = this.now();
    this.tick(at);
    if (!['left', 'right', 'forward', 'backward', 'spin', 'stop'].includes(action)) {
      return Promise.resolve(this.rejectedResult(action, 'invalid_action'));
    }
    if (this.phase !== 'running') {
      return Promise.resolve(this.rejectedResult(action, 'game_not_running'));
    }
    if (action === 'stop') {
      this.stop();
      return Promise.resolve(this.completedResult('stop', 0, false, 0));
    }
    if (!Number.isInteger(steps) || steps < 1 || steps > 3) {
      return Promise.resolve(this.rejectedResult(action, 'steps_must_be_between_1_and_3'));
    }
    if (action === 'spin' && steps !== 1) {
      return Promise.resolve(this.rejectedResult(action, 'spin_accepts_one_step'));
    }
    if (this.queue.length + (this.currentAction ? 1 : 0) >= 2) {
      return Promise.resolve(this.rejectedResult(action, 'action_queue_full'));
    }
    return new Promise<ActionResult>((resolve) => {
      const pending: PendingAction = {
        action,
        steps: action === 'spin' ? 1 : steps,
        resolve,
        startedAt: null,
        dueAt: null,
        stepStart: { ...this.position },
        stepTarget: { ...this.position },
        stepsCompleted: 0,
        touchedBoundary: false,
        collected: 0,
      };
      this.queue.push(pending);
      this.emit('action_queued', this.lastTime, { action, steps: pending.steps });
      this.startNextAction(this.lastTime);
    });
  }

  /** 推进至当前实际位置，再取消当前动作和队列，不回退位移和得分。 */
  public stop(): void {
    this.tick();
    const at = this.lastTime;
    if (this.currentAction) this.cancelAction(this.currentAction, at, 'stopped');
    while (this.queue.length > 0) {
      const pending = this.queue.shift();
      if (pending) this.cancelAction(pending, at, 'stopped');
    }
    this.idleSince = at;
  }

  /** 上游截止事件提前到达时立即结算，不能延长本局。 */
  public end(): void {
    this.tick();
    if (this.phase === 'running') this.finish(this.now());
  }

  /** 合并配置并校验边界，避免运行时出现不可达的随机位置。 */
  private mergeConfig(overrides: Partial<GameConfig> | undefined): GameConfig {
    const merged: GameConfig = {
      ...DEFAULT_GAME_CONFIG,
      ...overrides,
      bounds: { ...DEFAULT_GAME_CONFIG.bounds, ...(overrides?.bounds ?? {}) },
    };
    this.assertPositiveFinite(merged.gameDurationMs, 'game duration');
    this.assertPositiveFinite(merged.appleLifespanMs, 'apple lifespan');
    this.assertPositiveFinite(merged.appleRespawnDelayMs, 'apple respawn delay');
    this.assertPositiveFinite(merged.stepDistance, 'step distance');
    this.assertPositiveFinite(merged.stepDurationMs, 'step duration');
    this.assertPositiveFinite(merged.spinDurationMs, 'spin duration');
    this.assertPositiveFinite(merged.fatigueDurationMs, 'fatigue duration');
    this.assertPositiveFinite(merged.appleCollisionRadius, 'apple collision radius');
    if (!Number.isInteger(merged.maxApples) || merged.maxApples < 1) throw new Error('max apples must be positive');
    if (!Number.isInteger(merged.fatigueAfterActions) || merged.fatigueAfterActions < 1) throw new Error('fatigue threshold must be positive');
    if (!(merged.bounds.minX < merged.bounds.maxX) || !(merged.bounds.minZ < merged.bounds.maxZ)) throw new Error('invalid game bounds');
    return merged;
  }

  /** 校验必须为有限正数的配置值。 */
  private assertPositiveFinite(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  }

  /** 清空上一局的苹果、动作和计分状态。 */
  private resetRound(): void {
    this.stop();
    this.apples.clear();
    this.respawns.length = 0;
    this.score = 0;
    this.movementCount = 0;
    this.fatigued = false;
    this.fatigueUntil = null;
    this.idleSince = null;
    this.position = { ...this.initialPosition };
  }

  /** 在指定时刻生成一个不与现有苹果重叠的苹果。 */
  private spawnApple(at: number, lifespanMs: number): void {
    if (this.phase === 'finished' || this.apples.size >= this.config.maxApples) return;
    const position = this.randomApplePosition();
    const apple: AppleState = {
      id: `apple-${++this.appleSequence}`,
      position,
      spawnedAt: at,
      expiresAt: at + lifespanMs,
    };
    this.apples.set(apple.id, apple);
    this.emit('apple_spawned', at, { apple: { ...apple, position: { ...position } } });
  }

  /** 生成随机位置，有限尝试失败时用确定性的网格候选点兜底。 */
  private randomApplePosition(): Position {
    const { minX, maxX, minZ, maxZ } = this.config.bounds;
    const margin = this.config.appleCollisionRadius;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = {
        x: this.rangeRandom(minX + margin, maxX - margin),
        z: this.rangeRandom(minZ + margin, maxZ - margin),
      };
      if (this.isValidApplePosition(candidate)) return candidate;
    }
    for (let x = minX + margin; x <= maxX - margin; x += Math.max(1, margin * 2)) {
      for (let z = minZ + margin; z <= maxZ - margin; z += Math.max(1, margin * 2)) {
        const candidate = { x, z };
        if (this.isValidApplePosition(candidate)) return candidate;
      }
    }
    throw new Error('no valid apple spawn position');
  }

  /** 判断候选位置是否不与牛和现有苹果重叠。 */
  private isValidApplePosition(candidate: Position): boolean {
    if (this.distance(candidate, this.position) < this.config.appleCollisionRadius * 2) return false;
    for (const apple of this.apples.values()) {
      if (this.distance(candidate, apple.position) < this.config.appleCollisionRadius * 2) return false;
    }
    return true;
  }

  /** 生成指定范围内的随机数。 */
  private rangeRandom(min: number, max: number): number {
    const value = this.random();
    const normalized = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    return min + (max - min) * normalized;
  }

  /** 按时间顺序处理所有到期、补位和动作完成事件。 */
  private processUntil(target: number, includeTarget: boolean): void {
    while (true) {
      const next = this.nextTimelineEvent(target, includeTarget);
      if (!next) break;
      this.advancePosition(next.at);
      this.lastTime = next.at;
      this.updateFatigue(next.at);
      if (next.kind === 'expire') this.expireApple(next.at, next.appleId!);
      else if (next.kind === 'respawn') this.respawnApple(next.at, next.respawn!);
      else if (next.kind === 'collect') this.collectApple(next.appleId!, next.at);
      else this.completeActionStep(next.at);
    }
    this.advancePosition(target);
    this.lastTime = target;
    this.updateFatigue(target);
  }

  /** 找出下一个事件，时间相同时保证苹果到期优先于动作碰撞。 */
  private nextTimelineEvent(target: number, includeTarget: boolean): TimelineEvent | null {
    const canProcess = (at: number) => at < target || (includeTarget && at <= target);
    let best: TimelineEvent | null = null;
    const choose = (candidate: TimelineEvent, priority: number): void => {
      if (!candidate || !canProcess(candidate.at)) return;
      if (!best || candidate.at < best.at || (candidate.at === best.at && priority < this.eventPriority(best.kind))) best = candidate;
    };
    for (const apple of this.apples.values()) {
      choose({ at: apple.expiresAt, kind: 'expire', appleId: apple.id }, 0);
      const contactAt = this.contactTime(apple);
      if (contactAt !== null) choose({ at: contactAt, kind: 'collect', appleId: apple.id }, 2);
    }
    for (const respawn of this.respawns) choose({ at: respawn.dueAt, kind: 'respawn', respawn }, 1);
    if (this.currentAction?.dueAt !== null && this.currentAction?.dueAt !== undefined) choose({ at: this.currentAction.dueAt, kind: 'action' }, 3);
    return best;
  }

  /** 返回时间线事件的优先级。 */
  private eventPriority(kind: TimelineEvent['kind']): number {
    return kind === 'expire' ? 0 : kind === 'respawn' ? 1 : kind === 'collect' ? 2 : 3;
  }

  /** 处理一个苹果到期，并从到期时刻安排独立补位。 */
  private expireApple(at: number, appleId: string): void {
    const apple = this.apples.get(appleId);
    if (!apple || apple.expiresAt !== at) return;
    this.apples.delete(appleId);
    this.respawns.push({ dueAt: at + this.config.appleRespawnDelayMs });
    this.emit('apple_expired', at, { appleId });
  }

  /** 处理补位任务；到截止时刻后的补位不会执行。 */
  private respawnApple(at: number, respawn: PendingRespawn): void {
    const index = this.respawns.indexOf(respawn);
    if (index >= 0) this.respawns.splice(index, 1);
    this.spawnApple(at, this.roundAppleLifespanMs);
  }

  /** 启动队列中的下一个动作，并安排其第一个完成时刻。 */
  private startNextAction(at: number): void {
    if (this.currentAction || this.queue.length === 0 || this.phase !== 'running') return;
    const pending = this.queue.shift()!;
    this.currentAction = pending;
    this.idleSince = null;
    this.prepareStep(pending, at);
    this.emit('action_started', at, { action: pending.action, steps: pending.steps });
  }

  /** 完成当前动作的一步或整段转圈，并决定是否继续队列。 */
  private completeActionStep(at: number): void {
    const pending = this.currentAction;
    if (!pending) return;
    if (pending.action === 'spin') {
      pending.stepsCompleted = 1;
    } else {
      pending.stepsCompleted += 1;
      this.emit('action_step', at, { action: pending.action, position: { ...this.position }, touchedBoundary: pending.touchedBoundary, collected: pending.collected });
    }
    this.completeMovementAction(at);
    if (pending.stepsCompleted < pending.steps) {
      this.prepareStep(pending, at);
      return;
    }
    this.currentAction = null;
    this.idleSince = at;
    this.emit('action_completed', at, { action: pending.action, steps: pending.stepsCompleted, collected: pending.collected });
    pending.resolve(this.completedResult(pending.action, pending.stepsCompleted, pending.touchedBoundary, pending.collected));
    this.startNextAction(at);
  }

  /** 保存当前小步的起终点与时长，后续按绝对时间插值。 */
  private prepareStep(pending: PendingAction, at: number): void {
    pending.startedAt = at;
    pending.stepStart = { ...this.position };
    pending.dueAt = at + (pending.action === 'spin' ? this.config.spinDurationMs : this.config.stepDurationMs);
    const direction = pending.action === 'left' ? { x: -1, z: 0 } : pending.action === 'right' ? { x: 1, z: 0 } : pending.action === 'forward' ? { x: 0, z: 1 } : pending.action === 'backward' ? { x: 0, z: -1 } : { x: 0, z: 0 };
    const intended = { x: this.position.x + direction.x * this.config.stepDistance, z: this.position.z + direction.z * this.config.stepDistance };
    pending.stepTarget = this.clampPosition(intended);
    pending.touchedBoundary ||= pending.stepTarget.x !== intended.x || pending.stepTarget.z !== intended.z;
  }

  /** 将牛推进到当前小步中对应的连续位置。 */
  private advancePosition(at: number): void {
    const pending = this.currentAction;
    if (!pending || pending.startedAt === null || pending.dueAt === null) return;
    const ratio = Math.min(1, Math.max(0, (at - pending.startedAt) / (pending.dueAt - pending.startedAt)));
    this.position = {
      x: pending.stepStart.x + (pending.stepTarget.x - pending.stepStart.x) * ratio,
      z: pending.stepStart.z + (pending.stepTarget.z - pending.stepStart.z) * ratio,
    };
  }

  /** 解线段与抓取圆的首次交点，换算为真实接触时刻。 */
  private contactTime(apple: AppleState): number | null {
    const pending = this.currentAction;
    if (!pending || pending.startedAt === null || pending.dueAt === null) return null;
    const dx = pending.stepTarget.x - pending.stepStart.x;
    const dz = pending.stepTarget.z - pending.stepStart.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared === 0) return null;
    const offsetX = pending.stepStart.x - apple.position.x;
    const offsetZ = pending.stepStart.z - apple.position.z;
    const projection = offsetX * dx + offsetZ * dz;
    const discriminant = projection * projection - lengthSquared * (offsetX * offsetX + offsetZ * offsetZ - this.config.appleCollisionRadius ** 2);
    if (discriminant < 0) return null;
    const entry = (-projection - Math.sqrt(discriminant)) / lengthSquared;
    const exit = (-projection + Math.sqrt(discriminant)) / lengthSquared;
    if (exit < 0 || entry > 1) return null;
    const at = Math.max(this.lastTime, apple.spawnedAt, pending.startedAt + Math.max(0, entry) * (pending.dueAt - pending.startedAt));
    const exitAt = pending.startedAt + Math.min(1, exit) * (pending.dueAt - pending.startedAt);
    return at <= exitAt && at < apple.expiresAt ? at : null;
  }

  /** 抓取一个仍然有效的苹果并安排一秒后的补位。 */
  private collectApple(appleId: string, at: number): void {
    const apple = this.apples.get(appleId);
    if (!apple || apple.expiresAt <= at) return;
    this.apples.delete(appleId);
    this.score += 1;
    if (this.currentAction) this.currentAction.collected += 1;
    this.respawns.push({ dueAt: at + this.config.appleRespawnDelayMs });
    this.emit('apple_collected', at, { appleId, position: { ...apple.position }, score: this.score });
  }

  /** 完成一个小步或转圈后累计疲惫计数。 */
  private completeMovementAction(at: number): void {
    this.movementCount += 1;
    if (!this.fatigued && this.movementCount >= this.config.fatigueAfterActions) {
      this.fatigued = true;
      this.fatigueUntil = at + this.config.fatigueDurationMs;
      this.emit('tired_entered', at, { until: this.fatigueUntil, movementCount: this.movementCount });
    }
  }

  /** 在疲惫持续时间结束时恢复，并清零连续动作计数。 */
  private updateFatigue(at: number): void {
    if (this.fatigued && this.fatigueUntil !== null && at >= this.fatigueUntil) {
      const recoveredAt = this.fatigueUntil;
      this.fatigued = false;
      this.fatigueUntil = null;
      this.movementCount = 0;
      this.emit('recovered', recoveredAt, {});
    }
    if (!this.fatigued && this.currentAction === null && this.idleSince !== null && at >= this.idleSince + 5_000) {
      this.movementCount = 0;
    }
  }

  /** 结束本局并取消尚未完成的动作和补位任务。 */
  private finish(at: number): void {
    if (this.phase !== 'running') return;
    this.phase = 'finished';
    this.respawns.length = 0;
    if (this.currentAction) this.cancelAction(this.currentAction, at, 'game_ended');
    while (this.queue.length > 0) {
      const pending = this.queue.shift();
      if (pending) this.cancelAction(pending, at, 'game_ended');
    }
    this.emit('game_ended', at, { score: this.score });
  }

  /** 取消动作并确保其 Promise 只解析一次。 */
  private cancelAction(pending: PendingAction, at: number, reason: string): void {
    if (this.currentAction === pending) this.currentAction = null;
    this.emit('action_cancelled', at, { action: pending.action, reason, stepsCompleted: pending.stepsCompleted });
    pending.resolve(this.cancelledResult(pending.action, pending.stepsCompleted, pending.touchedBoundary, pending.collected, reason));
  }

  /** 创建拒绝结果。 */
  private rejectedResult(action: ActionName, reason: string): ActionResult {
    return { ...this.completedResult(action, 0, false, 0), status: 'rejected', reason };
  }

  /** 创建完成结果并带上最新快照数据。 */
  private completedResult(action: ActionName, stepsCompleted: number, touchedBoundary: boolean, collected: number): ActionResult {
    const snapshot = this.snapshot();
    return { status: 'completed', action, stepsCompleted, touchedBoundary, collected, score: snapshot.score, fatigued: snapshot.fatigued, remainingMs: snapshot.remainingMs };
  }

  /** 创建取消结果并带上取消原因。 */
  private cancelledResult(action: ActionName, stepsCompleted: number, touchedBoundary: boolean, collected: number, reason: string): ActionResult {
    const result = this.completedResult(action, stepsCompleted, touchedBoundary, collected);
    return { ...result, status: 'cancelled', reason };
  }

  /** 发送事件并附带事件发生时的快照。 */
  private emit(type: GameEvent['type'], at: number, payload: Record<string, unknown>): void {
    const event: GameEvent = { id: `event-${++this.eventSequence}`, type, at, payload };
    this.publish([event]);
  }

  /** 通知表现层，空事件数组用于更新倒计时等持续变化的快照。 */
  private publish(events: readonly GameEvent[]): void {
    const snapshot = this.snapshot();
    this.lastPublishedTime = this.lastTime;
    for (const listener of this.listeners) {
      try {
        listener(snapshot, events);
      } catch {
        console.error('Game snapshot listener failed');
      }
    }
  }

  /** 将位置限制在场地边界内。 */
  private clampPosition(position: Position): Position {
    return {
      x: Math.min(this.config.bounds.maxX, Math.max(this.config.bounds.minX, position.x)),
      z: Math.min(this.config.bounds.maxZ, Math.max(this.config.bounds.minZ, position.z)),
    };
  }

  /** 计算两点间距离。 */
  private distance(a: Position, b: Position): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

}
