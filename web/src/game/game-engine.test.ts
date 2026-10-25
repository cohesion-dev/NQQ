import { GameEngine } from './game-engine';
import { ActionResult, GameEvent } from './types';

/** 最小测试断言，避免游戏规则测试依赖浏览器或渲染库。 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

/** 断言两个值相等。 */
function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message}; expected ${String(expected)}, got ${String(actual)}`);
}

/** 通过注入时钟创建可重复的测试引擎。 */
function createTestEngine() {
  let current = 0;
  const randomValues = [0.1, 0.5, 0.9, 0.5, 0.2, 0.2, 0.8, 0.8];
  let randomIndex = 0;
  const engine = new GameEngine({
    now: () => current,
    random: () => randomValues[randomIndex++ % randomValues.length],
    config: { stepDistance: 1.5, stepDurationMs: 100 },
  });
  return {
    engine,
    setTime: (value: number) => { current = value; },
  };
}

/** 推进一个动作直到完成，并返回规则引擎产生的实际结果。 */
async function completeAction(engine: GameEngine, setTime: (value: number) => void, action: Parameters<GameEngine['requestAction']>[0], at: number, steps = 1): Promise<ActionResult> {
  const resultPromise = engine.requestAction(action, steps);
  let result: ActionResult | undefined;
  resultPromise.then((value) => { result = value; });
  for (let current = at; current <= at + 10_000 && !result; current += 50) {
    setTime(current);
    engine.tick(current);
    await Promise.resolve();
  }
  assert(result, `动作 ${action} 应在测试时间窗内完成`);
  return result;
}

/** 覆盖苹果生命周期、移动碰撞、疲惫、停止和一分钟结算。 */
export async function runSelfTest(): Promise<void> {
  const { engine, setTime } = createTestEngine();
  const events: GameEvent[] = [];
  engine.subscribe((_snapshot, batch) => events.push(...batch));

  // 固定三秒样例用于验证既有生命周期边界，与默认寿命分开。
  engine.start(3000, 60_000);
  assertEqual(engine.snapshot().apples.length, 2, '游戏开始应生成两颗苹果');
  assertEqual(engine.snapshot().remainingMs, 60_000, '测试截止时间应覆盖一局剩余时长');

  const firstMove = await completeAction(engine, setTime, 'left', 300, 3);
  assertEqual(firstMove.status, 'completed', '移动动作应完成');
  assertEqual(firstMove.collected, 1, '移动路径经过苹果时应抓到苹果');
  assertEqual(engine.snapshot().score, 1, '抓到苹果应加一分');
  assertEqual(engine.snapshot().apples.length, 1, '抓到苹果后场内应暂时剩一颗');

  const collectedAt = events.find((event) => event.type === 'apple_collected')!.at;
  assert(collectedAt > 0 && collectedAt < 300, '抓取时刻应为路径上的真实接触时刻');
  setTime(collectedAt + 999);
  engine.tick(collectedAt + 999);
  assertEqual(engine.snapshot().apples.length, 1, '补位延迟未到时不能生成苹果');
  setTime(collectedAt + 1_000);
  engine.tick(collectedAt + 1_000);
  assertEqual(engine.snapshot().apples.length, 2, '抓到苹果一秒后应补位');

  setTime(2_999);
  engine.tick(2_999);
  assertEqual(engine.snapshot().score, 1, '苹果过期不应扣分');
  setTime(3_000);
  engine.tick(3_000);
  assert(events.some((event) => event.type === 'apple_expired'), '苹果到期应产生事件');
  setTime(4_000);
  engine.tick(4_000);
  assertEqual(engine.snapshot().apples.length, 2, '苹果到期一秒后应独立补位');

  setTime(10_000);
  await completeAction(engine, setTime, 'right', 10_600);
  await completeAction(engine, setTime, 'forward', 11_200);
  await completeAction(engine, setTime, 'left', 15_800);
  assert(engine.snapshot().fatigued, '连续完成三个动作后应进入疲惫');
  setTime(30_000);
  engine.tick(30_000);
  assert(!engine.snapshot().fatigued, '疲惫持续时间结束后应恢复');
  assertEqual(engine.snapshot().movementCount, 0, '恢复后连续动作计数应清零');

  setTime(20_000);
  const first = engine.requestAction('left', 3);
  const second = engine.requestAction('right');
  engine.stop();
  const cancelled = await Promise.all([first, second]);
  assert(cancelled.every((result) => result.status === 'cancelled'), '停止应取消当前和排队动作');
  assertEqual(engine.snapshot().currentAction, null, '停止后不能保留当前动作');

  setTime(60_000);
  engine.tick(60_000);
  assertEqual(engine.snapshot().phase, 'finished', '到达测试截止时间应结束游戏');
  const afterEnd = await engine.requestAction('left');
  assertEqual(afterEnd.status, 'rejected', '结束后动作应被拒绝');
  assertEqual(engine.snapshot().remainingMs, 0, '结束后剩余时间应为零');

  const endEvents = events.filter((event) => event.type === 'game_ended').length;
  engine.tick(65_000);
  assertEqual(events.filter((event) => event.type === 'game_ended').length, endEvents, '游戏结束事件只应出现一次');

  setTime(70_000);
  engine.start(500);
  assertEqual(engine.snapshot().score, 0, '新局应清零得分');
  assertEqual(engine.snapshot().position.x, 0, '新局应回到初始位置');
  engine.tick(70_500);
  assertEqual(engine.snapshot().apples.length, 0, '自定义苹果寿命应生效');
  engine.tick(71_500);
  assertEqual(engine.snapshot().apples[0].expiresAt, 72_000, '补位苹果应继续使用本局自定义寿命');

  const boundsEngine = new GameEngine({ config: { stepDistance: 4, stepDurationMs: 100 }, now: () => 0 });
  boundsEngine.start();
  assertEqual(boundsEngine.snapshot().endsAt, 180_000, '默认游戏时长应为三分钟');
  assertEqual(boundsEngine.snapshot().apples[0].expiresAt, 60_000, '默认苹果有效期应为一分钟');
  const boundsResult = await completeAction(boundsEngine, () => {}, 'left', 300, 3);
  assertEqual(boundsResult.touchedBoundary, true, '移动触边应通过结果报告');
  assertEqual(boundsResult.stepsCompleted, 2, '触边后应提前结束动作');
  assertEqual(boundsEngine.snapshot().position.x, -5, '移动不能越过场地边界');

  const queueTest = createTestEngine();
  queueTest.engine.start();
  const queued = Array.from({ length: 2 }, () => queueTest.engine.requestAction('spin'));
  assertEqual((await queueTest.engine.requestAction('left')).status, 'rejected', '满队列应拒绝新请求');
  queueTest.engine.stop();
  assert((await Promise.all(queued)).every((result) => result.status === 'cancelled'), '停止应解析所有等待结果');
  assertEqual(queueTest.engine.snapshot().movementCount, 0, '取消动作不应计入疲惫');

  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let threw = false;
    try { new GameEngine().start(invalid); } catch { threw = true; }
    assert(threw, `非法寿命 ${invalid} 应被拒绝`);
  }

  const snapshot = queueTest.engine.snapshot();
  snapshot.position.x = 99;
  snapshot.apples.length = 0;
  assertEqual(queueTest.engine.snapshot().position.x, 0, '调用方不能通过快照改写位置');
  assertEqual(queueTest.engine.snapshot().apples.length, 2, '调用方不能通过快照删除苹果');

  await testContinuousMovement();
}

/** 覆盖连续移动、真实抓取时间、停止位置与疲惫的小步计数。 */
async function testContinuousMovement(): Promise<void> {
  let time = 0;
  let randomIndex = 0;
  const randomValues = [0, 0.5, 1, 0.5];
  const engine = new GameEngine({
    now: () => time,
    random: () => randomValues[randomIndex++ % randomValues.length],
    config: { stepDistance: 4, stepDurationMs: 400, appleCollisionRadius: 1 },
  });
  const events: GameEvent[] = [];
  engine.subscribe((_snapshot, batch) => events.push(...batch));
  engine.start(2_000);
  const move = engine.requestAction('left');
  time = 200;
  engine.tick();
  assertEqual(engine.snapshot().position.x, -2, '移动阶段位置应连续推进');
  assertEqual(engine.snapshot().actionPhase, 'walk', '移动直接进入行走阶段');
  time = 500;
  engine.tick();
  assertEqual(engine.snapshot().position.x, -4, '行走阶段位置应连续推进');
  assertEqual(engine.snapshot().heading, 'front', '玩家视角移动不改变逻辑朝向');
  time = 600;
  engine.tick();
  assertEqual(engine.snapshot().score, 1, '移动路径经过苹果应立即抓取');
  const collectedAt = events.find((event) => event.type === 'apple_collected')?.at;
  assertEqual(collectedAt, 300, '抓取事件使用真实接触时刻');
  assertEqual((await move).collected, 1, '动作结果应包含执行中已抓取的苹果');

  // 玩家视角回归：向左后向前，第二个动作必须沿固定前方 z+ 移动，不能继续沿左侧 x-。
  let directionTime = 0;
  const directionEngine = new GameEngine({ now: () => directionTime, config: { stepDurationMs: 600 } });
  directionEngine.start();
  const leftPromise = directionEngine.requestAction('left');
  directionTime = 1_200;
  directionEngine.tick();
  assertEqual((await leftPromise).status, 'completed', '向左动作应完成');
  assertEqual(directionEngine.snapshot().position.x, -1, '向左应改变玩家视角的 x');
  assertEqual(directionEngine.snapshot().position.z, 0, '向左不应改变玩家视角的 z');
  const forwardPromise = directionEngine.requestAction('forward');
  directionTime = 1_800;
  directionEngine.tick();
  assertEqual(directionEngine.snapshot().position.x, -1, '向前不应继续向左');
  assert(directionEngine.snapshot().position.z > 0, '向前应沿玩家视角 z+ 移动');
  directionTime = 2_100;
  directionEngine.tick();
  assertEqual((await forwardPromise).status, 'completed', '向前动作应完成');
  time = 700;
  engine.tick();
  assertEqual(engine.snapshot().apples.length, 1, '真实接触后一秒前不能补位');
  time = 1_300;
  engine.tick();
  assertEqual(engine.snapshot().apples.length, 2, '真实接触后一秒恰好补位');

  const stopping = new GameEngine({ now: () => 0, config: { stepDistance: 4, stepDurationMs: 400 } });
  stopping.start();
  const stopped = stopping.requestAction('left');
  stopping.stop();
  assertEqual((await stopped).status, 'cancelled', '停止应取消未完成动作');
  assertEqual(stopping.snapshot().position.x, 0, '停止应保留当前实际位置');

  const fatigue = createTestEngine();
  fatigue.engine.start();
  await completeAction(fatigue.engine, fatigue.setTime, 'right', 600);
  await completeAction(fatigue.engine, fatigue.setTime, 'left', 1_200);
  await completeAction(fatigue.engine, fatigue.setTime, 'forward', 1_800);
  assert(fatigue.engine.snapshot().fatigued, '连续三个完整动作后应疲惫');

  const deadline = new GameEngine({ now: () => 0 });
  deadline.start(3_000, 50);
  const interrupted = deadline.requestAction('right');
  deadline.tick(50);
  assertEqual(deadline.snapshot().phase, 'finished', '服务端提前截止时间应保留');
  assert(Math.abs(deadline.snapshot().position.x - 1 / 12) < 1e-9, '截止时保留当前玩家视角移动位置');
  assertEqual((await interrupted).status, 'cancelled', '截止应取消未完成动作');
}
