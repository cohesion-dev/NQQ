import assert from 'node:assert/strict';
import { CIRCLE_DURATION_SECONDS, sampleCircleMotion } from '../shared/circle-motion.ts';
import { GameEngine } from '../web/src/game/game-engine.ts';
import type { GameConfig, GameEvent, Position } from '../web/src/game/types.ts';
import { firstCircleContactProgress } from '../web/src/game/circle-path.ts';
import { toSceneSnapshot } from '../web/src/scene/SceneView.ts';

/** 用真实随机位置入口放置苹果，并注入可控时钟。 */
function createSpinGame(target: Position = { x: 3, z: 2 }, config: Partial<GameConfig> = {}, initialPosition = { x: 0, z: 0 }, lifespan = 60_000, respawnTarget?: Position) {
  let now = 0;
  const radius = config.appleCollisionRadius ?? 0.8;
  const randomValues = [target, ...(respawnTarget ? [respawnTarget] : [])].flatMap((point) => [
    (point.x + 5 - radius) / (10 - radius * 2), (point.z + 4 - radius) / (8 - radius * 2),
  ]);
  const engine = new GameEngine({
    now: () => now, random: () => randomValues.shift() ?? 0.99,
    initialPosition, config: { maxApples: 1, ...config },
  });
  const events: GameEvent[] = [];
  engine.subscribe((_snapshot, batch) => events.push(...batch));
  engine.start(lifespan);
  return { engine, events, setTime: (at: number) => { now = at; engine.tick(); } };
}

/** 比较几何量，允许三角函数产生的浮点舍入。 */
function near(actual: number, expected: number): void {
  assert(Math.abs(actual - expected) < 1e-6, `Expected ${expected}, got ${actual}`);
}

/** 验证真实圆周、抓取时刻、停止、触边、截止及排队起点。 */
export async function testGameSpin(): Promise<void> {
  const duration = CIRCLE_DURATION_SECONDS * 1_000;
  const path = createSpinGame();
  const circle = path.engine.requestAction('spin');
  let ended = false;
  void circle.then(() => { ended = true; });
  for (let at = 100; at < duration; at += 100) {
    path.setTime(at);
    const snapshot = path.engine.snapshot();
    const motion = sampleCircleMotion(at / 1_000);
    near(snapshot.position.x, motion.x);
    near(snapshot.position.z, motion.z);
    near(toSceneSnapshot(snapshot).cow.rotation, motion.rotation);
    near(Math.hypot(snapshot.position.x, snapshot.position.z + 1), 1);
  }
  await Promise.resolve();
  assert.equal(ended, false, 'A circle must not complete before returning to the front');
  path.setTime(duration);
  assert.equal((await circle).status, 'completed');
  assert.deepEqual(path.engine.snapshot().position, { x: 0, z: 0 });
  assert.equal(toSceneSnapshot(path.engine.snapshot()).cow.rotation, 0);
  assert.equal(path.engine.snapshot().movementCount, 1, 'One full circle counts as one action');

  const stopped = createSpinGame();
  const interrupted = stopped.engine.requestAction('spin');
  stopped.setTime(duration / 2);
  stopped.engine.stop();
  assert.equal((await interrupted).status, 'cancelled');
  near(stopped.engine.snapshot().position.x, 0);
  near(stopped.engine.snapshot().position.z, -2);
  stopped.setTime(20_000);
  near(stopped.engine.snapshot().position.z, -2);
  assert.equal(stopped.engine.snapshot().movementCount, 0, 'An interrupted circle does not count as a completed action');

  const apple = { x: 0, z: -2 };
  const expectedContact = 300 + (Math.PI - 2 * Math.asin(0.8 / 2)) / (Math.PI * 2) * 3_600;
  const fine = createSpinGame(apple);
  const fineSpin = fine.engine.requestAction('spin');
  fine.setTime(expectedContact - 0.001);
  assert.equal(fine.engine.snapshot().score, 0);
  fine.setTime(expectedContact + 0.001);
  assert.equal(fine.engine.snapshot().score, 1);
  near(fine.events.find((event) => event.type === 'apple_collected')!.at, expectedContact);
  fine.setTime(expectedContact + 999);
  assert.equal(fine.engine.snapshot().apples.length, 0);
  fine.setTime(expectedContact + 1_001);
  assert.equal(fine.engine.snapshot().apples.length, 1, 'Collection respawns an apple after one second during the circle');
  fine.setTime(duration);
  assert.equal((await fineSpin).collected, 1);

  const coarse = createSpinGame(apple);
  const coarseSpin = coarse.engine.requestAction('spin');
  coarse.setTime(duration);
  assert.equal((await coarseSpin).collected, 1, 'A single tick must still collect apples on the intervening arc');
  near(coarse.events.find((event) => event.type === 'apple_collected')!.at, expectedContact);
  const missed = createSpinGame({ x: 0, z: -1 }, { appleCollisionRadius: 0.1 });
  const missSpin = missed.engine.requestAction('spin');
  missed.setTime(duration);
  assert.equal((await missSpin).collected, 0, 'The center of a circle is not part of the walked path');

  for (const [respawn, expected] of [[{ x: -1, z: -1 }, 2], [{ x: 1, z: -1 }, 1]] as const) {
    const replacement = createSpinGame({ x: 1, z: -1 }, { appleCollisionRadius: 0.1 }, undefined, 60_000, respawn);
    const replacementSpin = replacement.engine.requestAction('spin');
    replacement.setTime(duration);
    assert.equal((await replacementSpin).collected, expected, 'New apples are tested only against the remaining arc');
  }

  // 接触与到期同刻必须先过期；游戏截止同刻也不能加分。
  const contactAt = firstCircleContactProgress({ x: 0, z: 0 }, apple, 0.8, 0)! * duration;
  const expired = createSpinGame(apple, {}, undefined, contactAt);
  const expiredSpin = expired.engine.requestAction('spin');
  expired.setTime(duration);
  assert.equal((await expiredSpin).collected, 0);
  assert.equal(expired.events.filter((event) => event.type === 'apple_expired').length, 1);
  const deadline = createSpinGame(apple, { gameDurationMs: contactAt });
  const deadlineSpin = deadline.engine.requestAction('spin');
  deadline.setTime(duration);
  assert.equal((await deadlineSpin).reason, 'game_ended');
  assert.equal(deadline.engine.snapshot().score, 0);
  assert.equal(deadline.engine.snapshot().phase, 'finished');

  for (const [origin, expected] of [
    [{ x: 4.5, z: 0 }, { x: 5, z: Math.sqrt(3) / 2 - 1 }],
    [{ x: -4.5, z: 0 }, { x: -5, z: -Math.sqrt(3) / 2 - 1 }],
    [{ x: 0, z: -3 }, { x: 1, z: -4 }],
  ]) {
    const edge = createSpinGame({ x: -3, z: 2 }, {}, origin);
    const edgeSpin = edge.engine.requestAction('spin');
    edge.setTime(duration);
    assert.equal((await edgeSpin).touchedBoundary, true);
    near(edge.engine.snapshot().position.x, expected.x);
    near(edge.engine.snapshot().position.z, expected.z);
  }

  const queued = createSpinGame();
  const move = queued.engine.requestAction('left');
  const queuedSpin = queued.engine.requestAction('spin');
  queued.setTime(600 + duration / 2);
  assert.equal((await move).status, 'completed');
  near(queued.engine.snapshot().position.x, -1);
  near(queued.engine.snapshot().position.z, -2);
  queued.setTime(600 + duration);
  assert.equal((await queuedSpin).status, 'completed');
  assert.deepEqual(queued.engine.snapshot().position, { x: -1, z: 0 });
}
