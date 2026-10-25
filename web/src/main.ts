import './styles.css';
import { GameEngine, type ActionResult } from './game/engine';
import { SceneView } from './scene/SceneView';
import { UiController } from './ui/UiController';
import { LinxClient, type LinxMessage } from './linx/LinxClient';
import { GameAudio } from './audio/GameAudio';
import { LinxAudio } from './audio/LinxAudio';
import { PcmRecorder } from './audio/PcmRecorder';
import { canPerformAction, chatSkills } from '../../shared/tools';
import { ChatIdleTimer } from './scene/ChatIdleTimer';

/** 默认进入聊天模式；只有灵矽调用开始游戏工具后才启动抓苹果规则。 */
function startApp(): void {
  const root = document.querySelector<HTMLDivElement>('#app')!;
  const game = new GameEngine();
  const scene = new SceneView(root);
  const effects = new GameAudio();
  const recorder = new PcmRecorder();
  const idleTimer = new ChatIdleTimer();
  let connected = false;
  let mode: 'chat' | 'apple-game' = 'chat';
  let currentRound = '';
  let lifespan = 60_000;
  let recorderStarted = false;
  const inFlightTools = new Map<string, Promise<Record<string, unknown> | ActionResult | undefined>>();
  const client = new LinxClient((message) => void receive(message), (frame) => { void audio.push(frame); });
  const ui = new UiController(root);
  const audio = new LinxAudio((active) => {
    idleTimer.reset();
    if (active) {
      scene.cancelIdleDance();
      const activeTurn = recorder.isSpeechActive;
      recorder.pause();
      if (activeTurn) client.send({ type: 'speech.stop' });
    } else recorder.resume();
  }, (code) => ui.notice(code === 'AUDIO_PLAYBACK_BLOCKED'
    ? '请轻触页面以允许播放牛七七的声音。'
    : `语音播放失败：${code}，请刷新页面重试。`));

  /** 展示字幕和本地结算提示，只有灵矽下发的音频可以发出角色声音。 */
  function say(text: string): void {
    idleTimer.reset();
    scene.cancelIdleDance();
    ui.say(text);
  }

  /** 结束监听，不把未实际开始的授权请求误认为已上传语音。 */
  function stopRecording(): void {
    if (recorder.stop()) client.send({ type: 'speech.stop' });
    recorderStarted = false;
  }

  /** 页面进入电话模式后持续监听，由 VAD 自动切分每一轮语音。 */
  function startRecorder(): void {
    if (!connected || recorderStarted) return;
    recorderStarted = true;
    void recorder.start({
      onSpeechStart: () => {
        audio.stop();
        idleTimer.reset();
        scene.cancelIdleDance();
        client.send({ type: 'speech.start' });
      },
      onSpeechStop: () => { client.send({ type: 'speech.stop' }); },
      onFrame: (frame) => client.sendAudio(frame),
    }).then(() => {
      // 麦克风授权期间也可能收到回复，采集就绪后仍需遵守播放占用。
      if (audio.speaking) recorder.pause();
    }).catch(() => {
      recorderStarted = false;
      ui.notice('无法使用麦克风，请在浏览器设置中允许访问后重试。');
    });
  }

  /** 处理网关转发的灵矽消息和两个模式的工具结果。 */
  async function receive(message: LinxMessage): Promise<void> {
    if (message.type === 'audio.config') { audio.configure(message.params); return; }
    if (message.type === 'audio.start') { audio.start(); return; }
    if (message.type === 'audio.stop') { audio.finish(message.aborted === true); return; }
    if (message.type === 'ready') {
      idleTimer.reset();
      connected = true;
      startRecorder();
      return;
    }
    if (message.type === 'round' && message.mode === 'apple-game') {
      idleTimer.reset();
      inFlightTools.clear();
      currentRound = message.roundId;
      lifespan = 60_000;
      mode = 'apple-game';
      scene.setMode(mode);
      ui.setMode(mode);
      game.start(lifespan, Date.now() + Math.max(1, message.endsAt - message.serverNow));
      return;
    }
    if (message.type === 'mode') {
      idleTimer.reset();
      inFlightTools.clear();
      mode = message.mode === 'apple-game' ? 'apple-game' : 'chat';
      scene.setMode(mode);
      ui.setMode(mode);
      if (mode === 'chat') game.end();
      return;
    }
    if (message.type === 'tool') {
      idleTimer.reset();
      scene.cancelIdleDance();
      const existing = inFlightTools.get(message.requestId);
      const resultPromise = existing ?? handleTool(message);
      if (!existing) inFlightTools.set(message.requestId, resultPromise);
      const result = await resultPromise;
      if (result !== undefined) client.send({ type: 'result', roundId: message.roundId || currentRound, requestId: message.requestId, result, failed: 'status' in result && result.status !== 'completed' });
      return;
    }
    if (message.type === 'transcript') {
      idleTimer.reset();
      scene.cancelIdleDance();
      ui.say(message.text, '你');
      return;
    }
    if (message.type === 'reply') {
      say(message.text);
      return;
    }
    if (message.type === 'finished') {
      // 先让规则引擎发出唯一的结束事件，由订阅回调统一播报结算。
      game.end();
      inFlightTools.clear();
      mode = 'chat'; currentRound = '';
      scene.setMode(mode); ui.setMode(mode);
      return;
    }
    if (message.type === 'cancel') { idleTimer.reset(); game.stop(); scene.cancelChatSkill(); return; }
    if (message.type === 'error' || message.type === 'activation') {
      audio.stop();
      connected = false; stopRecording(); scene.cancelChatSkill();
      ui.notice(connectionError(message));
      return;
    }
    if (message.type === 'disconnected') {
      audio.stop();
      connected = false; stopRecording(); scene.cancelChatSkill();
      ui.notice('语音连接已断开，请刷新页面后重试。');
    }
  }

  /** 游戏动作走规则引擎，聊天技能独立播放并等待实际结果。 */
  async function handleTool(message: LinxMessage): Promise<Record<string, unknown> | ActionResult | undefined> {
    if (message.name === 'self.niuqiqi.start_apple_game') {
      if (mode === 'apple-game' && game.snapshot().phase === 'running') return { status: 'completed', mode: 'apple-game', message: 'Apple game already started' };
      mode = 'apple-game';
      scene.setMode(mode); ui.setMode(mode);
      game.start(60_000, Date.now() + 180_000);
      return { status: 'completed', mode: 'apple-game', message: 'Apple game started' };
    }
    if (message.name === 'self.niuqiqi.exit_apple_game') {
      const score = game.snapshot().score;
      game.end(); mode = 'chat'; currentRound = '';
      scene.setMode(mode); ui.setMode(mode);
      say(`这局抓到了 ${score} 个苹果。`);
      return { status: 'completed', mode: 'chat', score };
    }
    if (message.name === 'self.niuqiqi.get_status') {
      const snapshot = game.snapshot();
      return { mode, phase: snapshot.phase, score: snapshot.score, remainingMs: snapshot.remainingMs, fatigued: snapshot.fatigued };
    }
    if (message.name === 'self.niuqiqi.do_action') {
      const action = message.args.action;
      if (!canPerformAction(mode, action)) return { status: 'rejected', reason: 'action_unavailable_in_mode' };
      if (mode === 'chat') {
        if (action === 'stop') {
          scene.cancelChatSkill();
          return { status: 'completed', action, mode: 'chat' };
        }
        const skill = chatSkills.find((name) => name === action)!;
        return { ...await scene.playChatSkill(skill) };
      }
      if (mode !== 'apple-game' || game.snapshot().phase !== 'running') return { status: 'rejected', reason: 'game_not_running' };
      return game.requestAction(message.args.action, message.args.steps);
    }
    return undefined;
  }

  /** 把接入错误转换为可执行提示，保留英文错误码便于排查。 */
  function connectionError(message: LinxMessage): string {
    if (message.type === 'activation') return `请到灵矽控制台绑定激活码 ${message.code} 后刷新页面。`;
    const descriptions: Record<string, string> = {
      LINX_NOT_CONFIGURED: '请在本地 .env 填写 LINX_AGENT_ID 并重启网关。',
      DEVICE_IN_USE: '绑定设备正在被另一个页面使用，请先关闭另一页面。',
      DEVICE_BIND_FAILED: '设备绑定失败，请检查智能体和密钥权限。',
      LINX_SETUP_TIMEOUT: '灵矽握手或工具发现超时，请检查模型工具配置。',
      LINX_CONNECTION_FAILED: '灵矽连接失败，请检查设备绑定和网络。',
    };
    return descriptions[message.code] ?? `灵矽接入异常：${message.code ?? 'UNKNOWN_ERROR'}`;
  }

  game.subscribe((snapshot, events) => {
    scene.render(snapshot, events); ui.render(snapshot);
    for (const event of events) {
      if (event.type === 'apple_collected') effects.effect('grab');
      if (event.type === 'tired_entered') effects.effect('tired');
      if (event.type === 'game_ended' && mode === 'apple-game') {
        mode = 'chat';
        currentRound = '';
        scene.setMode(mode);
        ui.setMode(mode);
        say(`三分钟到！我抓到了 ${snapshot.score} 个苹果。还想和我聊点什么？`);
      }
    }
  });
  scene.setMode('chat');
  ui.render(game.snapshot()); scene.render(game.snapshot());
  /** 启动页面后建立聊天连接，让用户打开应用即可和牛七七说话。 */
  void client.connect().catch((error) => ui.notice(`无法连接牛七七：${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`));
  /** 推进游戏时钟，聊天静默三秒后随机轮播闲置动作。 */
  function tick(): void {
    if (mode === 'apple-game') game.tick();
    const talking = recorder.isSpeechActive || audio.speaking;
    scene.setConversationTalking(talking);
    // 闲置动作属于本地表现，不应等待灵矽连接；未互动三秒即可开始随机播放。
    if (idleTimer.update(performance.now(), mode === 'chat' && !document.hidden,
      talking, scene.isChatSkillPlaying, scene.isIdleDancePlaying)) scene.playIdleDance();
    scene.setSpeechAmplitude(audio.amplitude);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  document.addEventListener('pointerdown', () => {
    void audio.unlock().catch(() => ui.notice('无法启用声音，请检查浏览器播放权限。'));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { connected = false; game.stop(); scene.cancelChatSkill(); stopRecording(); audio.stop(); client.close(); }
    else void client.connect();
  });
  window.addEventListener('pagehide', () => { game.stop(); recorder.stop(); audio.dispose(); effects.dispose(); client.close(); scene.dispose(); });
}

startApp();
