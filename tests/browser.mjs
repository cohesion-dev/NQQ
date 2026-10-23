import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.NQQ_BROWSER_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  // 页面契约模拟不访问真实账号，不代表灵矽语音或真机验收通过。
  const context = await browser.newContext({ ...devices['iPhone 12 Pro Max'], viewport: { width: 428, height: 926 } });
  const page = await context.newPage();
  const errors = [];
  const results = [];
  const requests = [];
  let socket;
  const roundId = 'browser-test-round';
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.route('**/api/session', (route) => route.fulfill({ json: { status: 'ready' } }));
  await page.routeWebSocket('**/api/linx', (connection) => {
    socket = connection;
    connection.onMessage((data) => {
      const message = JSON.parse(data.toString());
      requests.push(message);
      if (message.type === 'start') connection.send(JSON.stringify({ type: 'round', roundId, serverNow: Date.now(), endsAt: Date.now() + 60000 }));
      if (message.type === 'result') results.push(message);
    });
    connection.send(JSON.stringify({ type: 'ready' }));
  });
  // 权限拒绝是可复现的界面测试，实际采音另做真机验收。
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
    });
  });
  await page.goto(process.env.NQQ_TEST_URL || 'http://127.0.0.1:5173/');
  await page.locator('canvas').waitFor();
  assert.equal(await page.locator('[data-lifetime]').inputValue(), '10');
  assert.equal(await page.locator('[data-live], [data-action], .chat-input, [data-send]').count(), 0);
  await page.locator('[data-start]').click();
  await page.locator('[data-talk]').waitFor();
  assert.equal(await page.locator('.bottom-panel button').count(), 1);
  assert.equal(await page.locator('.bottom-panel input').count(), 0);
  assert.equal(await page.locator('[data-talk]').isEnabled(), true);

  socket.send(JSON.stringify({ type: 'tool', requestId: 'move-1', roundId, name: 'self.niuqiqi.do_action', args: { action: 'left', steps: 3 } }));
  await page.clock.runFor(2000);
  await page.waitForFunction(() => document.querySelector('.status-pill')?.textContent.includes('还能抓'));
  assert.equal(results[0]?.result.status, 'completed');
  assert.equal(results[0]?.result.stepsCompleted, 3);
  assert.equal(results[0]?.result.fatigued, true);
  socket.send(JSON.stringify({ type: 'reply', roundId, text: '你慢点我要累死了' }));
  await page.waitForFunction(() => document.querySelector('.speech')?.textContent === '你慢点我要累死了');

  // 手机完整屏幕和浏览器工具栏压缩后的可见区域都不得溢出。
  await mkdir('test-results', { recursive: true });
  for (const height of [926, 746]) {
    await page.setViewportSize({ width: 428, height });
    const fits = await page.evaluate(() => {
      const talk = document.querySelector('[data-talk]').getBoundingClientRect();
      const stage = document.querySelector('.stage').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth
        && document.documentElement.scrollHeight <= innerHeight + 1
        && talk.top >= 0 && talk.bottom <= innerHeight && stage.height > 150;
    });
    assert.equal(fits, true, `layout fits 428x${height}`);
    await page.screenshot({ path: `test-results/iphone12-pro-max-${height}.png`, fullPage: true });
  }

  const talk = page.locator('[data-talk]');
  await talk.focus();
  await page.keyboard.down('Space');
  await page.waitForFunction(() => document.querySelector('[data-notice]')?.textContent.includes('允许访问'));
  await page.keyboard.up('Space');
  assert.equal(requests.some((request) => request.type === 'speech.start'), false);
  assert.equal(await talk.isEnabled(), true);
  assert.equal(await page.locator('[data-action], .chat-input, [data-send]').count(), 0);

  await page.clock.fastForward(61000);
  await page.locator('[data-ready]').waitFor();
  assert.equal(await page.locator('[data-time]').textContent(), '0s');
  await page.locator('[data-ready]').click();
  assert.equal(await page.locator('[data-lifetime]').inputValue(), '10');
  assert.deepEqual(errors, []);
  console.info('Voice-only UI, mocked tool execution, iPhone layout, permission refusal and fixed round tests passed');
} finally { await browser.close(); }
