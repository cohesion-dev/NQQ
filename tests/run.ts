import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { runSelfTest } from '../web/src/game/game-engine.test.ts';
import { validTool } from '../shared/tools.ts';

await runSelfTest();
assert.equal(validTool('self.niuqiqi.do_action', { action: 'left', steps: 3 }), true);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'shell', steps: 1 }), false);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'left', steps: 4 }), false);
assert.equal(validTool('self.niuqiqi.do_action', { action: 'spin', steps: 2 }), false);
assert.equal(validTool('self.niuqiqi.get_status', { coordinates: true }), false);
assert.equal(validTool('self.niuqiqi.get_status', [] as unknown as Record<string, unknown>), false);

/** 在音频工作线程沙箱内送入真实采样块，检查跨块降采样帧计数与格式。 */
async function testPcm(rate: number): Promise<void> {
  let Processor: any;
  const frames: ArrayBuffer[] = [];
  const context = vm.createContext({
    sampleRate: rate,
    AudioWorkletProcessor: class { port = { postMessage: (frame: ArrayBuffer) => frames.push(frame) }; },
    registerProcessor: (_name: string, constructor: any) => { Processor = constructor; },
  });
  vm.runInContext(await readFile('web/src/audio/pcm-worklet.js', 'utf8'), context);
  const processor = new Processor();
  for (let offset = 0; offset < rate; offset += 128) {
    processor.process([[new Float32Array(Math.min(128, rate - offset)).fill(0.25)]]);
  }
  assert.equal(frames.length, 50, `one second at ${rate} produces 50 frames`);
  assert(frames.every((frame) => frame.byteLength === 640));
  assert(frames.every((frame) => [...new Int16Array(frame)].every((sample) => Math.abs(sample - 8191) <= 1)));
}
await testPcm(44100);
await testPcm(48000);
console.info('Game rules, tool validation and PCM resampling tests passed');
