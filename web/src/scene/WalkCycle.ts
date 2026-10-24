import * as THREE from 'three';

/** 在模型没有行走片段时，使用已命名的左右腿骨骼交替迈步。 */
export class WalkCycle {
  private readonly legs: Array<{ bone: THREE.Bone; rest: THREE.Quaternion; side: number; knee: boolean }> = [];
  private readonly offset = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3(1, 0, 0);
  private wasMoving = false;

  /** 当前模型使用 Mixamo 骨骼名，只匹配明确的腿骨，不猜测数字骨骼。 */
  constructor(model: THREE.Object3D) {
    model.traverse((object) => {
      if (!(object instanceof THREE.Bone)) return;
      const match = object.name.match(/(Left|Right)(UpLeg|Leg)$/i);
      if (!match) return;
      this.legs.push({ bone: object, rest: object.quaternion.clone(), side: match[1].toLowerCase() === 'left' ? 1 : -1, knee: match[2].toLowerCase() === 'leg' });
    });
  }

  /** 每帧从原始姿态计算摆腿，停止后恢复一次，避免累计旋转。 */
  update(elapsedSeconds: number, moving: boolean): void {
    if (!moving && !this.wasMoving) return;
    for (const { bone, rest, side, knee } of this.legs) {
      const swing = Math.sin(elapsedSeconds * 10) * side;
      const angle = moving ? (knee ? Math.max(0, -swing) * 0.45 : swing * 0.3) : 0;
      bone.quaternion.copy(rest).multiply(this.offset.setFromAxisAngle(this.axis, angle));
    }
    this.wasMoving = moving;
  }
}
