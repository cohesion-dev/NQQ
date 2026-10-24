import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { runSelfTest } from '../web/src/game/game-engine.test.ts';
import { validTool } from '../shared/tools.ts';
import { testChatSkills } from './chat-skills.test.ts';
import { testGameSpin } from './game-spin.test.ts';

await runSelfTest();
await testChatSkills();
await testGameSpin();
assert.equal(validTool('self.niuqiqi.do_action', { action: 'left', steps: 3 }), true);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'shell', steps: 1 }), false);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'left', steps: 4 }), false);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'left', steps: 0 }), false);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'spin', steps: 2 }), false);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'somersault' }), true);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'somersault', steps: 2 }), false);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'dance' }), true);
assert.equal(validTool('self.niuqiqi.get_status', { coordinates: true }), false);
assert.equal(validTool('self.niuqiqi.start_apple_game', {}), true);
assert.equal(validTool('self.niuqiqi.exit_apple_game', {}), true);
assert.equal(validTool('self.niuqiqi.start_apple_game', { extra: true }), false);
const uiSource = await readFile('web/src/ui/UiController.ts', 'utf8');
assert.match(uiSource, /game-numbers/);
assert.match(uiSource, /children\.length > 100/);
assert.equal(uiSource.includes('data-action'), false);
assert.equal(uiSource.includes('data-talk'), false);
assert.equal(validTool('self.niuqiqi.get_status', [] as unknown as Record<string, unknown>), false);

/** 在音频工作线程沙箱内送入真实采样块，检查跨块降采样帧计数与格式。 */
async function testPcm(rate: number): Promise<void> {
  let Processor: any;
  const frames: Array<{ pcm: ArrayBuffer; speech: boolean }> = [];
  const context = vm.createContext({
    sampleRate: rate,
    AudioWorkletProcessor: class { port = { postMessage: (frame: { pcm: ArrayBuffer; speech: boolean }) => frames.push(frame) }; },
    registerProcessor: (_name: string, constructor: any) => { Processor = constructor; },
  });
  vm.runInContext(await readFile('web/src/audio/pcm-worklet.js', 'utf8'), context);
  const processor = new Processor();
  for (let offset = 0; offset < rate; offset += 128) {
    processor.process([[new Float32Array(Math.min(128, rate - offset)).fill(0.25)]]);
  }
  assert.equal(frames.length, 50, `one second at ${rate} produces 50 frames`);
  assert(frames.every((frame) => frame.pcm.byteLength === 640));
  assert(frames.some((frame) => frame.speech));
  assert(frames.every((frame) => [...new Int16Array(frame.pcm)].every((sample) => Math.abs(sample - 8191) <= 1)));
}
await testPcm(44100);
await testPcm(48000);
/** 送入一段声音和一段静音，确认 VAD 会自动结束语音轮次。 */
async function testVadTransition(): Promise<void> {
  let Processor: any;
  const frames: Array<{ pcm: ArrayBuffer; speech: boolean }> = [];
  const context = vm.createContext({
    sampleRate: 16000,
    AudioWorkletProcessor: class { port = { postMessage: (frame: { pcm: ArrayBuffer; speech: boolean }) => frames.push(frame) }; },
    registerProcessor: (_name: string, constructor: any) => { Processor = constructor; },
  });
  vm.runInContext(await readFile('web/src/audio/pcm-worklet.js', 'utf8'), context);
  const processor = new Processor();
  for (let index = 0; index < 125; index += 1) processor.process([[new Float32Array(128).fill(0.25)]]);
  for (let index = 0; index < 125; index += 1) processor.process([[new Float32Array(128)]]);
  assert(frames.some((frame) => frame.speech));
  assert(frames.some((frame) => !frame.speech));
}
await testVadTransition();
console.info('Game rules, chat skills, tool validation and PCM resampling tests passed');
