import './styles.css';
import { GameEngine } from './game/engine';
import { SceneView } from './scene/SceneView';
import { UiController } from './ui/UiController';
import { LinxClient, type LinxMessage } from './linx/LinxClient';
import { MockAudio } from './audio/MockAudio';
import { PcmRecorder } from './audio/PcmRecorder';

/** 语音经灵矽调用游戏工具，模型和输出声音使用本地占位表现。 */
function startApp(): void {
  const root = document.querySelector<HTMLDivElement>('#app')!;
  const game = new GameEngine();
  const scene = new SceneView(root);
  const audio = new MockAudio();
  const recorder = new PcmRecorder();
  let connected = false;
  let currentRound = '';
  let lifespan = 10000;
  let startWait: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const client = new LinxClient((message) => void receive(message));
  const ui = new UiController(root, {
    start: async (seconds) => {
      connected = false; recorder.stop(); audio.stop(); client.close();
      lifespan = seconds * 1000;
      await client.connect();
      connected = true; ui.setVoiceState('ready');
      await new Promise<void>((resolve, reject) => {
        startWait = { resolve, reject };
        startTimer = setTimeout(() => { startWait = undefined; client.close(); reject(new Error('开局请求超时，请重试。')); }, 10000);
        client.startRound();
      });
      say('灵矽已经接通，我准备听你的指挥啦！');
    },
    voiceStart: () => {
      if (!connected || game.snapshot().phase !== 'running') return;
      audio.stop();
      void recorder.start(() => {
        client.send({ type: 'speech.start' }); ui.setVoiceState('recording');
      }, (frame) => client.sendAudio(frame)).catch(() => {
        ui.setVoiceState(connected ? 'ready' : 'unavailable');
        ui.notice('无法使用麦克风，请在浏览器设置中允许访问后，再按住说话。');
      });
    },
    voiceStop: stopRecording,
  });

  /** 角色声音使用本地占位，字幕与当前朗读一致。 */
  function say(text: string, interrupt = true): void { ui.say(text); audio.speak(text, interrupt); }

  /** 结束监听，不把未实际开始的授权请求误认为已经上传语音。 */
  function stopRecording(): void { if (recorder.stop()) client.send({ type: 'speech.stop' }); }

  /** 将灵矽请求交给游戏逻辑，并原样路由实际结果。 */
  async function receive(message: LinxMessage): Promise<void> {
    if (message.type === 'round') {
      currentRound = message.roundId;
      game.start(lifespan, Date.now() + Math.max(1, message.endsAt - message.serverNow));
      clearTimeout(startTimer); startWait?.resolve(); startWait = undefined;
    } else if (message.type === 'tool') {
      if (message.roundId !== currentRound || game.snapshot().phase !== 'running') return;
      const roundId = currentRound;
      const result = message.name === 'self.niuqiqi.get_status'
        ? { phase: game.snapshot().phase, score: game.snapshot().score, remainingMs: game.snapshot().remainingMs, fatigued: game.snapshot().fatigued }
        : await game.requestAction(message.args.action, message.args.steps);
      client.send({ type: 'result', roundId, requestId: message.requestId, result, failed: 'status' in result && result.status !== 'completed' });
    } else if (message.type === 'transcript') ui.say(message.text, '你（语音）');
    else if (message.type === 'reply' && message.roundId === currentRound && game.snapshot().phase === 'running') say(message.text, false);
    else if (message.type === 'cancel') game.stop();
    else if (message.type === 'finished') game.end();
    else if (message.type === 'error' || message.type === 'activation') {
      connected = false; ui.setVoiceState('unavailable');
      ui.notice(connectionError(message)); game.stop(); stopRecording();
      clearTimeout(startTimer); startWait?.reject(new Error(connectionError(message))); startWait = undefined;
    } else if (message.type === 'disconnected' && game.snapshot().phase === 'running') {
      connected = false; ui.setVoiceState('unavailable');
      game.stop(); stopRecording(); ui.notice('语音连接已断开，本局按原时间结算，请结算后重新连接。');
    }
  }

  /** 把接入错误转换为可执行提示，保留英文错误码便于本地排查。 */
  function connectionError(message: LinxMessage): string {
    if (message.type === 'activation') return `请到灵矽控制台将激活码 ${message.code} 绑定到牛七七，再点重试。`;
    const descriptions: Record<string, string> = {
      LINX_NOT_CONFIGURED: '请在本地 .env 填写 LINX_AGENT_ID 并重启网关。',
      DEVICE_IN_USE: '这个绑定设备正在被另一个页面使用，请先关闭另一页面。',
      DEVICE_BIND_FAILED: '设备绑定失败，请检查智能体与密钥权限。',
      LINX_SETUP_TIMEOUT: '灵矽握手或工具发现超时，请检查模型工具调用配置。',
      LINX_CONNECTION_FAILED: '灵矽连接失败，请检查设备绑定和网络。',
    };
    return descriptions[message.code] ?? `灵矽接入异常：${message.code ?? 'UNKNOWN_ERROR'}`;
  }

  game.subscribe((snapshot, events) => {
    scene.render(snapshot, events); ui.render(snapshot);
    for (const event of events) {
      if (event.type === 'apple_collected') audio.effect('grab');
      if (event.type === 'tired_entered') {
        audio.effect('tired');
      }
      if (event.type === 'game_ended') {
        connected = false; stopRecording(); client.close(); audio.effect('finish');
        say(`一分钟到！我抓到了 ${snapshot.score} 个苹果。导航辛苦啦！`);
      }
    }
  });
  ui.render(game.snapshot()); scene.render(game.snapshot());
  /** 帧循环只推进规则时钟，页面和场景从同一快照更新。 */
  function tick(): void {
    game.tick(); scene.setSpeechAmplitude(audio.speaking ? 0.35 + Math.sin(performance.now() / 80) * 0.2 : 0);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { connected = false; ui.setVoiceState('unavailable'); game.stop(); stopRecording(); audio.stop(); client.close(); }
    else game.tick();
  });
  window.addEventListener('pagehide', () => { game.stop(); recorder.stop(); audio.dispose(); client.close(); scene.dispose(); });
}

startApp();
