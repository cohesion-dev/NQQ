import { CIRCLE_DURATION_SECONDS, CIRCLE_RADIUS, CIRCLE_TURN_SECONDS, CIRCLE_WALK_SECONDS, sampleCircleMotion } from '../../../shared/circle-motion';
import type { GameConfig, Position } from './types';

/** 求圆弧首次进入苹果抓取范围的进度，包含跳帧与中途出现的苹果。 */
export function firstCircleContactProgress(origin: Position, target: Position, radius: number, from: number): number | null {
  const motion = sampleCircleMotion(from * CIRCLE_DURATION_SECONDS);
  if (Math.hypot(origin.x + motion.x - target.x, origin.z + motion.z - target.z) <= radius) return from;
  const dx = target.x - origin.x;
  const dz = target.z - (origin.z - CIRCLE_RADIUS);
  const distance = Math.hypot(dx, dz);
  if (distance === 0) return null;
  const cosine = (CIRCLE_RADIUS ** 2 + distance ** 2 - radius ** 2) / (2 * CIRCLE_RADIUS * distance);
  if (cosine > 1 + 1e-12) return null;

  // 距离条件化为角度区间，补齐跨零度的区间。
  const halfWidth = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const angle = Math.atan2(dx, dz);
  const fromAngle = Math.max(0, (from * CIRCLE_DURATION_SECONDS - CIRCLE_TURN_SECONDS) / CIRCLE_WALK_SECONDS * Math.PI * 2);
  let first: number | null = null;
  for (let cycle = -1; cycle <= 1; cycle++) {
    const center = angle + cycle * Math.PI * 2;
    const entry = Math.max(0, fromAngle, center - halfWidth);
    if (entry > Math.min(Math.PI * 2, center + halfWidth) + 1e-12) continue;
    const progress = (CIRCLE_TURN_SECONDS + entry / (Math.PI * 2) * CIRCLE_WALK_SECONDS) / CIRCLE_DURATION_SECONDS;
    if (first === null || progress < first) first = Math.max(from, progress);
  }
  return first;
}

/** 求完整圆首次越出矩形场地的位置，沿用移动动作触边提前结束的规则。 */
export function firstCircleBoundaryProgress(origin: Position, bounds: GameConfig['bounds']): number | null {
  let angle = Infinity;
  if (origin.x + CIRCLE_RADIUS > bounds.maxX) angle = Math.asin((bounds.maxX - origin.x) / CIRCLE_RADIUS);
  if (origin.x - CIRCLE_RADIUS < bounds.minX) angle = Math.min(angle, Math.PI + Math.asin((origin.x - bounds.minX) / CIRCLE_RADIUS));
  if (origin.z - CIRCLE_RADIUS * 2 < bounds.minZ) angle = Math.min(angle, Math.acos(1 - (origin.z - bounds.minZ) / CIRCLE_RADIUS));
  return Number.isFinite(angle) ? (CIRCLE_TURN_SECONDS + angle / (Math.PI * 2) * CIRCLE_WALK_SECONDS) / CIRCLE_DURATION_SECONDS : null;
}
