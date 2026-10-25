import assert from 'node:assert/strict';
import { canPerformAction, chatSkills } from '../shared/tools.ts';
import { ChatSkillPlayer } from '../web/src/scene/ChatSkillPlayer.ts';
import { ChatIdleTimer } from '../web/src/scene/ChatIdleTimer.ts';
import { CIRCLE_DURATION_SECONDS } from '../shared/circle-motion.ts';

/** 验证聊天动作边界；翻跟头已从工具和播放器移除。 */
export async function testChatSkills(): Promise<void> {
  assert.deepEqual(chatSkills, ['spin', 'jump', 'dance']);
  assert.equal(canPerformAction('chat', 'spin'), true);
  assert.equal(canPerformAction('chat', 'dance'), true);
  assert.equal(canPerformAction('chat', 'jump'), true);
  assert.equal(canPerformAction('apple-game', 'spin'), true);

  const player = new ChatSkillPlayer();
  const spinPromise = player.play('spin');
  player.update(CIRCLE_DURATION_SECONDS / 2);
  assert.equal(player.isCircling, true);
  assert.equal((await player.play('dance')).status, 'rejected');
  player.update(CIRCLE_DURATION_SECONDS / 2);
  assert.equal((await spinPromise).status, 'completed');
  assert.equal(player.isPlaying, false);

  const dance = player.play('dance');
  player.update(0.1);
  assert.equal(player.isPlaying, true);
  player.cancel();
  assert.equal((await dance).status, 'cancelled');

  const timer = new ChatIdleTimer();
  assert.equal(timer.update(0, true, false, false), false);
  assert.equal(timer.update(2_999, true, false, false), false);
  assert.equal(timer.update(3_000, true, false, false), true);
  timer.reset();
  assert.equal(timer.update(10_000, true, false, false), false);
  assert.equal(timer.update(13_000, true, false, false), true);
  assert.equal(timer.update(13_001, true, false, true, true), false);
  assert.equal(timer.update(13_002, true, false, false, false), false);
  assert.equal(timer.update(13_502, true, false, false, false), true);
  console.info('Chat spin/dance and idle timer tests passed');
}
