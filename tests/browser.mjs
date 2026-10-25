import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.NQQ_BROWSER_PATH || undefined,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    // 无 GPU 的 CI 环境回读 WebGL 画布会卡在共享图像，改为纯软件合成并关掉新截图路径。
    '--disable-gpu', '--disable-features=CDPScreenshotNewSurface',
  ],
});
try {
  // 使用模拟网关验证模式切换和页面契约，不代表真实灵矽或真机验收通过。
  // 软件 WebGL 使用 1 倍像素比，保持手机 CSS 视口，避免大贴图的 3 倍回读拖慢 CI。
  const context = await browser.newContext({ ...devices['iPhone 12 Pro Max'], deviceScaleFactor: 1, viewport: { width: 428, height: 926 } });
  const page = await context.newPage();
  const errors = [];
  const results = [];
  const resultWaiters = new Map();
  const waitResult = (id) => {
    const existing = results.find(message => message.requestId === id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing tool result: ${id}; errors=${errors.join(';')}`)), 10000);
      resultWaiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
  };
  let socket;
  const gameRoundId = 'browser-test-game';
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.routeWebSocket('**/api/linx', (connection) => {
    socket = connection;
    connection.onMessage((data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'result') {
        results.push(message);
        resultWaiters.get(message.requestId)?.(message);
        resultWaiters.delete(message.requestId);
      }
    });
    connection.send(JSON.stringify({ type: 'ready', mode: 'chat' }));
  });
  await page.route('**/api/session', (route) => route.fulfill({ json: { status: 'ready' } }));
  await page.addInitScript(() => {
    // 固定主动舞蹈选择，以便按 Hip_Hop_Dance_3 的实际时长核对完成时机。
    Math.random = () => 0.01;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
    });
  });
  const modelLoaded = page.waitForEvent('console', { predicate: (message) => message.text().startsWith('Loaded GLB cow model;') });
  await page.goto(process.env.NQQ_TEST_URL || 'http://127.0.0.1:5173/');
  await modelLoaded;
  await page.locator('.stage[data-game-model="ready"][data-idle-model="ready"]').waitFor();
  await page.locator('canvas').waitFor();
  assert.equal(await page.locator('button').count(), 0);
  assert.equal(await page.locator('.game-numbers').count(), 0);

  // 聊天技能不应开局，也不能在动画开始时就报告完成。
  for (const [action, duration] of [['spin', 4200], ['jump', 1867], ['dance', 4700]]) {
    const requestId = `chat-${action}`;
    socket.send(JSON.stringify({ type: 'tool', requestId, roundId: '', name: 'self.niuqiqi.do_action', args: { action } }));
    await page.clock.runFor(300);
    assert.equal(results.some((message) => message.requestId === requestId), false);
    assert.equal(await page.locator('.game-numbers').count(), 0);
    await page.clock.runFor(duration + 300);
    assert.equal(results.find((message) => message.requestId === requestId)?.result.status, 'completed');
  }
  socket.send(JSON.stringify({ type: 'tool', requestId: 'chat-stop', roundId: '', name: 'self.niuqiqi.do_action', args: { action: 'stop' } }));
  await page.clock.runFor(100);
  assert.equal(results.find((message) => message.requestId === 'chat-stop')?.result.status, 'completed');

  // 空闲表演不能阻塞后续主动动作；进入游戏时必须取消尚未结束的舞蹈。
  await page.clock.runFor(10_100);
  socket.send(JSON.stringify({ type: 'tool', requestId: 'dance-before-game', roundId: '', name: 'self.niuqiqi.do_action', args: { action: 'dance' } }));
  await page.clock.runFor(300);

  socket.send(JSON.stringify({ type: 'tool', requestId: 'start-1', roundId: gameRoundId, name: 'self.niuqiqi.start_apple_game', args: {} }));
  await page.locator('.game-numbers').waitFor();
  await page.clock.runFor(100);
  assert.equal(results.find((message) => message.requestId === 'dance-before-game')?.result.status, 'cancelled');
  assert.equal(await page.locator('button').count(), 0);
  assert.equal(await page.locator('.game-numbers').count(), 1);

  socket.send(JSON.stringify({ type: 'tool', requestId: 'move-1', roundId: gameRoundId, name: 'self.niuqiqi.do_action', args: { action: 'left', steps: 3 } }));
  await page.clock.runFor(3000);
  assert.equal((await waitResult('move-1')).result.status, 'completed');

  socket.send(JSON.stringify({ type: 'tool', requestId: 'game-spin', roundId: gameRoundId, name: 'self.niuqiqi.do_action', args: { action: 'spin' } }));
  await page.clock.runFor(2100);
  assert.equal(results.some((message) => message.requestId === 'game-spin'), false);
  await page.clock.runFor(2400);
  assert.equal(results.find((message) => message.requestId === 'game-spin')?.result.status, 'completed');

  socket.send(JSON.stringify({ type: 'reply', roundId: gameRoundId, mode: 'apple-game', text: '好的' }));
  // 权限提示先于回复出现，因此断言最后一条对话。
  await page.waitForFunction(() => {
    const messages = document.querySelectorAll('.conversation p');
    return messages[messages.length - 1]?.textContent === '七七：好的';
  });
  socket.send(JSON.stringify({ type: 'finished', roundId: gameRoundId }));
  await page.waitForFunction(() => document.querySelector('.game-numbers') === null);
  assert.equal(await page.locator('button').count(), 0);
  assert.equal(await page.locator('.game-numbers').count(), 0);

  await mkdir('test-results', { recursive: true });
  for (const height of [926, 746]) {
    await page.setViewportSize({ width: 428, height });
    const fits = await page.evaluate(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth
        && document.documentElement.scrollHeight <= innerHeight + 1
        && stage.top >= 0 && stage.bottom <= innerHeight && stage.height > 150;
    });
    assert.equal(fits, true, `layout fits 428x${height}`);
    // 假时钟会暂停动画帧，截图前恢复时钟，让页面能正常渲染出帧。
    await page.clock.resume();
    await page.screenshot({ path: `test-results/iphone12-pro-max-${height}.png`, fullPage: true, timeout: 60000 });
  }
  assert.deepEqual(errors, []);
  console.info('Chat/game mode switch, buttonless UI, mocked tools and iPhone layout tests passed');
} finally { await browser.close(); }
