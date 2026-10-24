import { CIRCLE_DURATION_SECONDS } from '../../../shared/circle-motion';

/** 地面坐标使用 x/z，三维垂直方向保留为 y。 */
export interface Position {
  x: number;
  z: number;
}

/** 牛可以执行的动作名称。 */
export type ActionName =
  | 'left'
  | 'right'
  | 'forward'
  | 'backward'
  | 'spin'
  | 'somersault'
  | 'stop';

/** 牛完成动作后默认面向的固定前方，以及动作中间的朝向。 */
export type Heading = 'front' | 'left' | 'back' | 'right';

/** 复合动作当前执行阶段。 */
export type ActionPhase = 'turn' | 'walk' | 'face_front' | 'spin' | 'somersault';

/** 游戏生命周期。 */
export type GamePhase = 'ready' | 'running' | 'finished';

/** 游戏规则配置。 */
export interface GameConfig {
  gameDurationMs: number;
  appleLifespanMs: number;
  appleRespawnDelayMs: number;
  maxApples: number;
  stepDistance: number;
  stepDurationMs: number;
  spinDurationMs: number;
  somersaultDurationMs: number;
  fatigueAfterActions: number;
  fatigueDurationMs: number;
  appleCollisionRadius: number;
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
}

/** 场内一个苹果的完整生命周期状态。 */
export interface AppleState {
  id: string;
  position: Position;
  spawnedAt: number;
  expiresAt: number;
}

/** 页面和工具调用读取的只读游戏快照。 */
export interface GameSnapshot {
  phase: GamePhase;
  score: number;
  remainingMs: number;
  apples: AppleState[];
  position: Position;
  fatigued: boolean;
  movementCount: number;
  currentAction: ActionName | null;
  actionPhase: ActionPhase | null;
  /** 当前动作阶段的完成比例，供模型动画同步采样。 */
  actionProgress: number;
  heading: Heading;
  targetHeading: Heading | null;
  queuedActions: number;
  startedAt: number | null;
  endsAt: number | null;
}

/** 游戏事实事件，表现层只能消费事件，不能反向改写规则。 */
export interface GameEvent {
  id: string;
  type:
    | 'game_started'
    | 'apple_spawned'
    | 'apple_expired'
    | 'apple_collected'
    | 'action_queued'
    | 'action_started'
    | 'action_step'
    | 'action_completed'
    | 'action_cancelled'
    | 'tired_entered'
    | 'recovered'
    | 'game_ended';
  at: number;
  payload: Record<string, unknown>;
}

/** 一次动作请求的处理结果。 */
export interface ActionResult {
  status: 'completed' | 'rejected' | 'cancelled';
  action: ActionName;
  reason?: string;
  stepsCompleted: number;
  touchedBoundary: boolean;
  collected: number;
  score: number;
  fatigued: boolean;
  heading: Heading;
  remainingMs: number;
}

/** 游戏引擎事件订阅函数。 */
export type GameEventListener = (snapshot: GameSnapshot, events: readonly GameEvent[]) => void;

/** 引擎创建参数。 */
export interface GameEngineOptions {
  config?: Partial<GameConfig>;
  now?: () => number;
  random?: () => number;
  initialPosition?: Position;
}

/** 默认规则常量。 */
export const DEFAULT_GAME_CONFIG: GameConfig = {
  gameDurationMs: 180_000,
  appleLifespanMs: 60_000,
  appleRespawnDelayMs: 1_000,
  maxApples: 2,
  stepDistance: 1,
  stepDurationMs: 600,
  spinDurationMs: CIRCLE_DURATION_SECONDS * 1_000,
  somersaultDurationMs: 1_800,
  fatigueAfterActions: 3,
  fatigueDurationMs: 5_000,
  appleCollisionRadius: 0.8,
  bounds: { minX: -5, maxX: 5, minZ: -4, maxZ: 4 },
};
