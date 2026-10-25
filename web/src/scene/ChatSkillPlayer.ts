import * as THREE from 'three';
import type { ChatSkill } from '../../../shared/tools';
import { CIRCLE_DURATION_SECONDS, sampleCircleMotion } from '../../../shared/circle-motion';

export interface ChatSkillResult {
  status: 'completed' | 'cancelled' | 'rejected';
  action: ChatSkill;
  mode: 'chat';
  reason?: string;
}

export interface ChatClipPlayback {
  action: THREE.AnimationAction;
  release: () => void;
}

interface ActiveSkill {
  skill: ChatSkill;
  elapsed: number;
  duration: number;
  automatic: boolean;
  playback?: ChatClipPlayback;
  onFinished?: (event: THREE.AnimationMixerEventMap['finished']) => void;
  resolve: (result: ChatSkillResult) => void;
}

/** 真实动画由混合器结束事件结算，绕圈和兜底动作使用独立节点。 */
export class ChatSkillPlayer {
  readonly group = new THREE.Group();
  readonly content = new THREE.Group();
  private active: ActiveSkill | null = null;

  /** 两层节点使角色绕身体中心翻转，地面坐标和原模型保持不变。 */
  constructor() {
    this.group.name = 'chat-skill-pivot';
    this.group.position.y = 1.6;
    this.content.position.y = -1.6;
    this.group.add(this.content);
  }

  /** 绕圈期间让模型播放腿部迈步，转向阶段也保留小步动作。 */
  get isCircling(): boolean { return this.active?.skill === 'spin'; }

  /** 动作占用状态供空闲计时使用，避免自动表演重叠。 */
  get isPlaying(): boolean { return this.active !== null; }

  /** 只有自动表演能被普通聊天打断，主动技能仍按原规则完成。 */
  get isAutomatic(): boolean { return this.active?.automatic ?? false; }

  /** 技能完成才解析结果；已有技能时拒绝重叠执行。 */
  play(skill: ChatSkill, playback?: ChatClipPlayback, automatic = false): Promise<ChatSkillResult> {
    if (this.active) return Promise.resolve({ status: 'rejected', action: skill, mode: 'chat', reason: 'skill_busy' });
    return new Promise((resolve) => {
      this.resetTransform();
      const active: ActiveSkill = {
        skill, elapsed: 0, duration: { spin: CIRCLE_DURATION_SECONDS, jump: 1.867, dance: 2.4 }[skill],
        playback, automatic, resolve,
      };
      this.active = active;
      if (playback) {
        active.onFinished = (event) => {
          if (event.action === playback.action) this.finish('completed');
        };
        playback.action.getMixer().addEventListener('finished', active.onFinished);
        playback.action.reset().setLoop(THREE.LoopOnce, 1);
        playback.action.clampWhenFinished = true;
        playback.action.play();
      }
    });
  }

  /** 绕中心走完一圈或完成前翻，回到起点并回正后才返回完成。 */
  update(delta: number): void {
    const active = this.active;
    if (!active || active.playback) return;
    active.elapsed = Math.min(active.duration, active.elapsed + delta);
    const progress = active.elapsed / active.duration;
    if (active.skill === 'spin') {
      const motion = sampleCircleMotion(active.elapsed);
      this.group.position.x = motion.x;
      this.group.position.z = motion.z;
      this.group.rotation.y = motion.rotation;
    }
    if (active.skill === 'dance') {
      this.group.rotation.z = Math.sin(progress * Math.PI * 12) * 0.16;
      this.group.rotation.y = Math.sin(progress * Math.PI * 6) * 0.3;
      this.group.position.y = 1.6 + Math.abs(Math.sin(progress * Math.PI * 12)) * 0.12;
    }
    if (progress === 1) {
      this.finish('completed');
    }
  }

  /** 停止、切模式、断线或销毁时取消技能并恢复站姿。 */
  cancel(): void {
    this.finish('cancelled');
  }

  /** 先解绑结束事件再归还模型控制权，取消后不能再回传完成。 */
  private finish(status: 'completed' | 'cancelled'): void {
    const active = this.active;
    this.active = null;
    this.resetTransform();
    if (!active) return;
    if (active.playback) {
      if (active.onFinished) active.playback.action.getMixer().removeEventListener('finished', active.onFinished);
      active.playback.action.stop();
      active.playback.release();
    }
    active.resolve({ status, action: active.skill, mode: 'chat', ...(status === 'cancelled' ? { reason: 'skill_cancelled' } : {}) });
  }

  /** 重置的是独立技能节点，不改动模型、游戏位置或原始骨骼。 */
  private resetTransform(): void {
    this.group.rotation.set(0, 0, 0);
    this.group.position.set(0, 1.6, 0);
  }
}
