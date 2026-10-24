export const CIRCLE_DURATION_SECONDS = 4.2;

/** 沿半径一米、位于起点后方的圆行走，起止先转向并最终回正。 */
export function sampleCircleMotion(elapsedSeconds: number): { x: number; z: number; rotation: number } {
  const turnSeconds = 0.3;
  const walkSeconds = CIRCLE_DURATION_SECONDS - turnSeconds * 2;
  const time = Math.max(0, Math.min(CIRCLE_DURATION_SECONDS, elapsedSeconds));
  if (time < turnSeconds) return { x: 0, z: 0, rotation: Math.PI / 2 * time / turnSeconds };
  if (time >= turnSeconds + walkSeconds) {
    const progress = (time - turnSeconds - walkSeconds) / turnSeconds;
    return { x: 0, z: 0, rotation: Math.PI * 2 + Math.PI / 2 * (1 - progress) };
  }
  const angle = (time - turnSeconds) / walkSeconds * Math.PI * 2;
  return { x: Math.sin(angle), z: Math.cos(angle) - 1, rotation: angle + Math.PI / 2 };
}
