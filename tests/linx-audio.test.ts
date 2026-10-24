import assert from 'node:assert/strict';
import { LinxAudioRelay } from '../server/audio-relay.ts';
import { LinxAudio } from '../web/src/audio/LinxAudio.ts';
import { LinxClient } from '../web/src/linx/LinxClient.ts';
import { readAudioParams } from '../shared/audio.ts';

/** 保留真实解码器，只替换扬声器，检查调度时间和最终输出采样。 */
class TestAudioContext {
  static instances: TestAudioContext[] = [];
  state = 'running';
  currentTime = 1;
  destination = {};
  sources: TestSource[] = [];
  buffers: Array<{ sampleRate: number; duration: number; data: Float32Array; getChannelData: () => Float32Array }> = [];
  /** 记录播放器申请的上下文。 */
  constructor() { TestAudioContext.instances.push(this); }
  /** 模拟已获准播放的音频上下文。 */
  async resume(): Promise<void> { this.state = 'running'; }
  /** 记录页面释放设备。 */
  async close(): Promise<void> { this.state = 'closed'; }
  /** 提供确定的输出采样，验证嘴型使用音频数据。 */
  createAnalyser(): unknown {
    return { fftSize: 0, connect() {}, getFloatTimeDomainData(data: Float32Array) { data.fill(0.1); } };
  }
  /** 记录解码后的采样率、长度与实际采样值。 */
  createBuffer(_channels: number, length: number, sampleRate: number): unknown {
    const data = new Float32Array(length);
    const buffer = { sampleRate, duration: length / sampleRate, data, getChannelData: () => data };
    this.buffers.push(buffer);
    return buffer;
  }
  /** 收集音源以模拟真实播放结束，而不是用收到 stop 代替完成。 */
  createBufferSource(): TestSource {
    const source = new TestSource();
    this.sources.push(source);
    return source;
  }
}

/** 可手动结束的音源，验证取消会停止已调度声音。 */
class TestSource {
  buffer: unknown;
  onended: (() => void) | null = null;
  startedAt = 0;
  stopped = false;
  /** 模拟连接扬声器。 */
  connect(): void {}
  /** 模拟释放连接。 */
  disconnect(): void {}
  /** 记录连续播放时间。 */
  start(at: number): void { this.startedAt = at; }
  /** 记录打断立即停止。 */
  stop(): void { this.stopped = true; }
}

/** 替换浏览器全局并在测试结束时完整恢复。 */
function replaceGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  };
}

/** 验证真实 Opus 解码、流式调度、完成边界与取消期间的异步竞争。 */
export async function testLinxAudio(): Promise<void> {
  assert.throws(() => readAudioParams({ format: 'mp3', sample_rate: 24000, channels: 1 }));
  assert.throws(() => readAudioParams({ format: 'opus', sample_rate: 44100, channels: 1 }));
  assert.throws(() => readAudioParams({ format: 'pcm', sample_rate: 16000, channels: 2 }));
  assert.throws(() => readAudioParams({ format: 'pcm', sample_rate: 16000, channels: 1, bit_depth: 32 }));
  const restore = replaceGlobal('AudioContext', TestAudioContext);
  const states: boolean[] = [];
  const errors: string[] = [];
  const audio = new LinxAudio((state) => states.push(state), (error) => errors.push(error));
  try {
    for (const sampleRate of [16000, 24000, 48000]) {
      audio.configure({ format: 'opus', sample_rate: sampleRate, channels: 1 });
      audio.start();
      // 有效的二十毫秒 Opus 静音包，经过实际 WebAssembly 解码。
      const first = audio.push(new Uint8Array([0xf8, 0xff, 0xfe]).buffer);
      const second = audio.push(new Uint8Array([0xf8, 0xff, 0xfe]).buffer);
      audio.finish();
      assert.equal(audio.speaking, true, 'Stop must wait for pending decoding');
      await Promise.all([first, second]);
      const context = TestAudioContext.instances.at(-1)!;
      const buffers = context.buffers.slice(-2);
      assert(buffers.every((buffer) => buffer.sampleRate === sampleRate && buffer.data.length === sampleRate * 0.02));
      const sources = context.sources.slice(-2);
      assert(Math.abs(sources[1].startedAt - sources[0].startedAt - 0.02) < 1e-9, 'Frames are scheduled consecutively');
      assert(audio.amplitude > 0, 'Mouth amplitude comes from output samples');
      assert.equal(audio.speaking, true, 'Receiving all frames does not mean playback finished');
      sources[0].onended!();
      assert.equal(audio.speaking, true);
      sources[1].onended!();
      assert.equal(audio.speaking, false);
      assert.equal(audio.amplitude, 0);
    }

    audio.configure({ format: 'pcm', sample_rate: 16000, channels: 1 });
    audio.start();
    await audio.push(new Uint8Array([0, 128, 0, 0, 255, 127]).buffer);
    const context = TestAudioContext.instances.at(-1)!;
    assert.deepEqual([...context.buffers.at(-1)!.data], [-1, 0, 32767 / 32768]);
    const cancelledSource = context.sources.at(-1)!;
    const lateEnd = cancelledSource.onended!;
    audio.finish(true);
    assert.equal(cancelledSource.stopped, true);
    assert.equal(audio.speaking, false);
    const count = context.sources.length;
    await audio.push(new Uint8Array([0, 0]).buffer);
    assert.equal(context.sources.length, count, 'Late frames after cancellation are ignored');

    audio.configure({ format: 'opus', sample_rate: 24000, channels: 1 });
    audio.start();
    const oldFrame = audio.push(new Uint8Array([0xf8, 0xff, 0xfe]).buffer);
    audio.stop();
    audio.start();
    const newFrame = audio.push(new Uint8Array([0xf8, 0xff, 0xfe]).buffer);
    await Promise.all([oldFrame, newFrame]);
    assert.equal(context.sources.length, count + 1, 'An old decoding task cannot restart sound');
    lateEnd();
    assert.equal(audio.speaking, true, 'An old ended callback cannot finish the new stream');
    audio.finish();
    context.sources.at(-1)!.onended!();
    assert.equal(audio.speaking, false);

    audio.start();
    audio.finish();
    assert.equal(audio.speaking, false, 'An empty response restores listening');
    assert.deepEqual(errors, []);
    audio.configure({ format: 'pcm', sample_rate: 16000, channels: 1 });
    audio.start();
    await audio.push(new Uint8Array([1]).buffer);
    assert.equal(audio.speaking, false, 'A decode failure releases the speaking state');
    assert.equal(errors.at(-1), 'INVALID_PCM_FRAME');
    assert.equal(states.at(-1), false);

    const resume = context.resume.bind(context);
    let allowPlayback!: () => void;
    context.state = 'suspended';
    context.resume = () => new Promise<void>((resolve) => {
      allowPlayback = () => { context.state = 'running'; resolve(); };
    });
    audio.start();
    const blocked = audio.push(new Uint8Array([0, 0]).buffer);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(errors.at(-1), 'AUDIO_PLAYBACK_BLOCKED', 'A blocked resume must prompt for a touch instead of failing silently');
    assert.equal(audio.speaking, true);
    allowPlayback();
    await blocked;
    audio.finish();
    context.sources.at(-1)!.onended!();
    assert.equal(audio.speaking, false, 'Playback can finish after the system grants permission');
    context.resume = resume;
  } finally { audio.dispose(); restore(); }
  await testAudioTransport();
}

/** 浏览器长连接替身保留二进制事件边界，避免把音频传给文字解析器。 */
class TestSocket extends EventTarget {
  static instances: TestSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  binaryType = 'blob';
  /** 收集新连接以模拟重连与旧连接事件。 */
  constructor(_url: string) { super(); TestSocket.instances.push(this); }
  /** 模拟连接关闭。 */
  close(): void { this.readyState = 3; }
  /** 当前测试只验证下行事件。 */
  send(): void {}
  /** 原样派发协议和音频事件。 */
  receive(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}

/** 串联网关转发与客户端收包，验证格式、打断过滤及重连隔离。 */
async function testAudioTransport(): Promise<void> {
  const restores = [
    replaceGlobal('WebSocket', TestSocket),
    replaceGlobal('location', { protocol: 'http:', host: 'localhost' }),
    replaceGlobal('fetch', async () => ({ ok: true })),
  ];
  const messages: Array<Record<string, unknown>> = [];
  const frames: ArrayBuffer[] = [];
  const client = new LinxClient((message) => messages.push(message), (frame) => frames.push(frame));
  try {
    const connection = client.connect();
    await Promise.resolve();
    const socket = TestSocket.instances.at(-1)!;
    assert.equal(socket.binaryType, 'arraybuffer');
    socket.receive(JSON.stringify({ type: 'ready' }));
    await connection;
    const relay = new LinxAudioRelay((message) => socket.receive(JSON.stringify(message)), (frame) => {
      socket.receive(Uint8Array.from(frame).buffer);
    });
    relay.configure({ format: 'opus', sample_rate: 24000, channels: 1 });
    const frame = new Uint8Array([0xf8, 0xff, 0xfe]);
    relay.push(frame);
    assert.equal(frames.length, 0);
    relay.handle({ type: 'tts', state: 'start' });
    relay.push(frame);
    assert.deepEqual(new Uint8Array(frames[0]), frame);
    relay.handle({ type: 'tts', state: 'stop', is_aborted: false });
    relay.push(frame);
    assert.equal(frames.length, 1);
    assert.deepEqual(messages.at(-1), { type: 'audio.stop', aborted: false });
    relay.handle({ type: 'tts', state: 'start' });
    relay.cancel();
    relay.push(frame);
    assert.equal(frames.length, 1);
    assert.deepEqual(messages.at(-1), { type: 'audio.stop', aborted: true });
    relay.handle({ type: 'tts', state: 'start' });
    relay.push(frame);
    relay.handle({ type: 'tts', state: 'stop', is_aborted: true });
    assert.equal(frames.length, 2);
    assert.deepEqual(messages.at(-1), { type: 'audio.stop', aborted: true });
    const reconnect = client.connect();
    await Promise.resolve();
    socket.receive(frame.buffer);
    assert.equal(frames.length, 2, 'An old connection cannot deliver audio after reconnect');
    TestSocket.instances.at(-1)!.receive(JSON.stringify({ type: 'ready' }));
    await reconnect;
  } finally { client.close(); for (const restore of restores.reverse()) restore(); }
}
