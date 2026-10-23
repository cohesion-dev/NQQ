import type * as THREE from 'three';

/** 场景中牛七七的姿态。 */
export type CowPose = 'idle' | 'walk' | 'spin' | 'reach' | 'grab' | 'pocket' | 'tired' | 'recover' | 'talk' | 'stop';

/** 场景展示阶段。 */
export type ScenePhase = 'ready' | 'running' | 'result';

/** 游戏快照中一个苹果的最小展示数据。 */
export interface SceneApple {
  id: string;
  x: number;
  z: number;
  /** 0 到 1，表示苹果剩余寿命比例。 */
  lifeRatio: number;
}

/** 由游戏逻辑提供给场景的只读快照。 */
export interface SceneSnapshot {
  phase: ScenePhase;
  cow: { x: number; z: number; rotation: number; pose: CowPose; tired: boolean };
  apples: SceneApple[];
  score: number;
}

/** 场景构造选项。 */
export interface SceneViewOptions {
  width?: number;
  height?: number;
  pixelRatio?: number;
  background?: number;
}

/** 可供 UI 侧使用的动作意图。 */
export type ActionName = 'left' | 'right' | 'forward' | 'backward' | 'spin' | 'stop';

/** 三维场景的公开接口。 */
export interface SceneViewApi {
  readonly shell: HTMLElement;
  readonly stage: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly threeScene: THREE.Scene;
  update(snapshot: SceneSnapshot): void;
  setSpeechAmplitude(value: number): void;
  dispose(): void;
}
