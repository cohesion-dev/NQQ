import type * as THREE from 'three';
import type { ChatSkill } from '../../../shared/tools';
import type { ChatSkillResult } from './ChatSkillPlayer';

/** 场景中牛七七的姿态。 */
export type CowPose = 'idle' | 'walk' | 'backward' | 'turn_left' | 'turn_right' | 'turn_back' | 'face_front' | 'spin' | 'reach' | 'grab' | 'pocket' | 'tired' | 'recover' | 'talk' | 'stop';

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
  cow: {
    x: number; z: number; rotation: number; pose: CowPose; tired: boolean;
    /** 游戏阶段进度驱动转身和后空翻，180 度转身播放两次脚步。 */
    actionProgress?: number;
    turnSteps?: number;
  };
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
  setMode(mode: 'chat' | 'apple-game'): void;
  playChatSkill(skill: ChatSkill): Promise<ChatSkillResult>;
  readonly isChatSkillPlaying: boolean;
  playIdleDance(): void;
  cancelIdleDance(): void;
  cancelChatSkill(): void;
  setSpeechAmplitude(value: number): void;
  dispose(): void;
}
