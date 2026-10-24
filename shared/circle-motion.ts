export const CIRCLE_DURATION_SECONDS = 4.2;
export const CIRCLE_TURN_SECONDS = 0.3;
export const CIRCLE_WALK_SECONDS = CIRCLE_DURATION_SECONDS - CIRCLE_TURN_SECONDS * 2;
export const CIRCLE_RADIUS = 1;

/** 沿半径一米、位于起点后方的圆行走，起止先转向并最终回正。 */
export function sampleCircleMotion(elapsedSeconds: number): { x: number; z: number; rotation: number } {
  const time = Math.max(0, Math.min(CIRCLE_DURATION_SECONDS, elapsedSeconds));
  if (time < CIRCLE_TURN_SECONDS) return { x: 0, z: 0, rotation: Math.PI / 2 * time / CIRCLE_TURN_SECONDS };
  if (time >= CIRCLE_TURN_SECONDS + CIRCLE_WALK_SECONDS) {
    const progress = (time - CIRCLE_TURN_SECONDS - CIRCLE_WALK_SECONDS) / CIRCLE_TURN_SECONDS;
    return { x: 0, z: 0, rotation: Math.PI * 2 + Math.PI / 2 * (1 - progress) };
  }
  const angle = (time - CIRCLE_TURN_SECONDS) / CIRCLE_WALK_SECONDS * Math.PI * 2;
  return { x: Math.sin(angle) * CIRCLE_RADIUS, z: (Math.cos(angle) - 1) * CIRCLE_RADIUS, rotation: angle + Math.PI / 2 };
}
