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
  setTime(at);
  engine.tick(at);
  return resultPromise;
}

/** 覆盖苹果生命周期、移动碰撞、疲惫、停止和一分钟结算。 */
export async function runSelfTest(): Promise<void> {
  const { engine, setTime } = createTestEngine();
  const events: GameEvent[] = [];
  engine.subscribe((_snapshot, batch) => events.push(...batch));

  // 固定三秒样例用于验证既有生命周期边界，与默认寿命分开。
  engine.start(3000);
  assertEqual(engine.snapshot().apples.length, 2, '游戏开始应生成两颗苹果');
  assertEqual(engine.snapshot().remainingMs, 60_000, '游戏开始时长应为一分钟');

  const firstMove = await completeAction(engine, setTime, 'left', 300, 3);
  assertEqual(firstMove.status, 'completed', '移动动作应完成');
  assertEqual(firstMove.collected, 1, '移动路径经过苹果时应抓到苹果');
  assertEqual(engine.snapshot().score, 1, '抓到苹果应加一分');
  assertEqual(engine.snapshot().apples.length, 1, '抓到苹果后场内应暂时剩一颗');

  const collectedAt = events.find((event) => event.type === 'apple_collected')!.at;
  assert(collectedAt > 100 && collectedAt < 200, '抓取时刻应为路径上的真实接触时刻');
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
  await completeAction(engine, setTime, 'right', 10_100);
  await completeAction(engine, setTime, 'forward', 10_200);
  await completeAction(engine, setTime, 'spin', 11_600);
  assert(engine.snapshot().fatigued, '连续完成三个动作后应进入疲惫');
  setTime(16_600);
  engine.tick(16_600);
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
  assertEqual(engine.snapshot().phase, 'finished', '到达一分钟应结束游戏');
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

  const boundsTest = createTestEngine();
  boundsTest.engine.start();
  const boundsResult = await completeAction(boundsTest.engine, boundsTest.setTime, 'left', 300, 3);
  boundsTest.setTime(300);
  const boundaryPromise = boundsTest.engine.requestAction('left', 3);
  boundsTest.setTime(600);
  boundsTest.engine.tick(600);
  assertEqual((await boundaryPromise).touchedBoundary, true, '移动触边应通过结果报告');
  assertEqual(boundsTest.engine.snapshot().position.x, -5, '移动不能越过场地边界');
  assertEqual(boundsResult.collected, 1, '路径碰撞应只抓取一次');

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
  engine.start(350);
  const move = engine.requestAction('left');
  time = 200;
  engine.tick();
  assertEqual(engine.snapshot().position.x, -2, '半步时位置应连续推进到一半');
  time = 300;
  engine.tick();
  assertEqual(engine.snapshot().score, 1, '到期前经过苹果应立即抓取，无需等待步伐完成');
  assertEqual(events.find((event) => event.type === 'apple_collected')?.at, 300, '抓取事件使用真实接触时刻');
  time = 400;
  engine.tick();
  assertEqual((await move).collected, 1, '动作结果应包含执行中已抓取的苹果');
  time = 1_299;
  engine.tick();
  assertEqual(engine.snapshot().apples.length, 0, '真实接触后一秒前不能补位');
  time = 1_300;
  engine.tick();
  assertEqual(engine.snapshot().apples.length, 1, '真实接触后一秒恰好补位');

  let tieTime = 0;
  let tieRandom = 0;
  const tie = new GameEngine({
    now: () => tieTime,
    random: () => randomValues[tieRandom++ % randomValues.length],
    config: { stepDistance: 4, stepDurationMs: 400, appleCollisionRadius: 1 },
  });
  tie.start(300);
  const tieMove = tie.requestAction('left');
  tieTime = 400;
  tie.tick();
  assertEqual((await tieMove).collected, 0, '接触与到期同刻时应到期优先');

  let skippedTime = 0;
  let skippedRandom = 0;
  const skipped = new GameEngine({
    now: () => skippedTime,
    random: () => randomValues[skippedRandom++ % randomValues.length],
    config: { stepDistance: 4, stepDurationMs: 400, appleCollisionRadius: 1 },
  });
  skipped.start(350);
  const skippedMove = skipped.requestAction('left');
  skippedTime = 400;
  skipped.tick();
  assertEqual((await skippedMove).collected, 1, '低帧率跨过接触和到期时，仍须按真实时序先抓取');

  const stopping = createTestEngine();
  stopping.engine.start();
  const stopped = stopping.engine.requestAction('right', 3);
  stopping.setTime(50);
  stopping.engine.stop();
  assertEqual(stopping.engine.snapshot().position.x, 0.75, '停止应先推进到当前实际位置');
  assertEqual((await stopped).stepsCompleted, 0, '未完成的小步不计入完成数');
  assertEqual(stopping.engine.snapshot().movementCount, 0, '未完成的小步不计入疲惫');
  stopping.setTime(20_000);
  stopping.engine.tick();
  assertEqual(stopping.engine.snapshot().position.x, 0.75, '后台恢复不能补记已取消的运动');

  const fatigue = createTestEngine();
  fatigue.engine.start();
  const threeSteps = fatigue.engine.requestAction('right', 3);
  fatigue.setTime(200);
  fatigue.engine.tick();
  assertEqual(fatigue.engine.snapshot().movementCount, 2, '每个完成的小步独立计数');
  fatigue.setTime(300);
  fatigue.engine.tick();
  await threeSteps;
  assert(fatigue.engine.snapshot().fatigued, '三步请求应在第三小步完成时疲惫');

  const idle = createTestEngine();
  idle.engine.start();
  await completeAction(idle.engine, idle.setTime, 'right', 100);
  idle.setTime(5_099);
  idle.engine.tick();
  assertEqual(idle.engine.snapshot().movementCount, 1, '空闲不足五秒时保留连续计数');
  idle.setTime(5_100);
  idle.engine.tick();
  assertEqual(idle.engine.snapshot().movementCount, 0, '正常状态空闲五秒清零连续计数');

  const deadline = createTestEngine();
  deadline.engine.start(3_000, 50);
  const interrupted = deadline.engine.requestAction('right');
  deadline.setTime(50);
  deadline.engine.tick();
  assertEqual(deadline.engine.snapshot().phase, 'finished', '服务端提前截止时间应保留');
  assertEqual(deadline.engine.snapshot().position.x, 0.75, '截止时保留此前已实际走到的位置');
  assertEqual((await interrupted).status, 'cancelled', '截止应取消未完成动作');
}
