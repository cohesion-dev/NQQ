import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { tools, validTool, canPerformAction } from '../shared/tools.ts';

type Message = Record<string, any>;
const agentId = process.env.LINX_AGENT_ID?.trim();
const apiKey = process.env.LINX_API_KEY?.trim();
const port = Number(process.env.PORT ?? 8787);
const sessions = new Map<string, { device: string; client: string }>();
const locked = new Set<string>();
let registryWrites = Promise.resolve();

/** 校验浏览器请求来源，格式不合法的来源也直接拒绝。 */
function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  try { return !!origin && new URL(origin).host === host; } catch { return false; }
}

/** 串行保存本地设备，避免两个页面同时激活时交叉写入文件。 */
function persistDevices(): Promise<void> {
  registryWrites = registryWrites.catch(() => {}).then(() => writeFile('.linx-devices.json', JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 }));
  return registryWrites;
}

/** 保留本地浏览器设备身份，避免重启开发服务后反复激活。 */
async function loadDevices(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile('.linx-devices.json', 'utf8'));
    for (const [key, value] of Object.entries(saved)) sessions.set(key, value as { device: string; client: string });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid local device registry');
  }
}

/** 返回服务端 JSON 状态，不向页面暴露任何灵矽凭证。 */
function json(response: import('node:http').ServerResponse, status: number, value: Message): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

await loadDevices();
/** 同时用于开发服务器中间件与独立部署的 HTTP 请求处理器。 */
export async function handleRequest(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
  if (request.url === '/api/config') return json(response, 200, { configured: !!agentId, sound: 'local-speech' });
  if (request.url === '/api/session' && request.method === 'POST') {
    const origin = request.headers.origin;
    if (origin && !sameOrigin(origin, request.headers.host)) return json(response, 403, { error: 'Forbidden' });
    let key = request.headers.cookie?.match(/(?:^|;\s*)nqq_device=([a-f0-9]{48})(?:;|$)/)?.[1];
    if (!key || !sessions.has(key)) {
      key = randomBytes(24).toString('hex');
      const bytes = randomBytes(6); bytes[0] = (bytes[0] | 2) & 254;
      sessions.set(key, { device: [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(':'), client: randomUUID() });
      try { await persistDevices(); }
      catch { sessions.delete(key); return json(response, 500, { error: 'Device registry unavailable' }); }
    }
    response.setHeader('Set-Cookie', `nqq_device=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    return json(response, 200, { status: 'ready' });
  }
  const assetRoot = resolve('dist');
  let pathname: string;
  try { pathname = decodeURIComponent((request.url ?? '/').split('?')[0]); }
  catch { return json(response, 400, { error: 'Invalid path' }); }
  const requested = resolve(assetRoot, `.${pathname}`);
  if (requested !== assetRoot && !requested.startsWith(assetRoot + sep)) return json(response, 403, { error: 'Forbidden' });
  try {
    const file = requested === assetRoot ? resolve(assetRoot, 'index.html') : requested;
    const data = await readFile(file);
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(data);
  } catch { json(response, 404, { error: 'Not found' }); }
}

/** 将设备网关挂到已有服务，开发时与页面共用端口。 */
export function attachGateway(http: import('node:http').Server | import('node:http2').Http2SecureServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  http.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/linx') return;
    const origin = request.headers.origin;
    if (!sameOrigin(origin, request.headers.host)) return socket.destroy();
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request));
  });

  /** 为一个浏览器连接建立独立的灵矽设备会话和本局请求映射。 */
  wss.on('connection', (browser: WebSocket, request: import('node:http').IncomingMessage) => {
    let upstream: WebSocket | undefined;
    let device = '';
    let sessionId = '';
    let roundId = '';
    let deadline = 0;
    let mode: 'chat' | 'apple-game' = 'chat';
    let ready = false;
    let listening = false;
    let closed = false;
    let helloReceived = false;
    let toolsDiscovered = false;
    let roundTimer: ReturnType<typeof setTimeout> | undefined;
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Map<string, { id: string | number; name?: string; timer?: ReturnType<typeof setTimeout>; result?: Message }>();

    /** 向当前页面发送协议事件。 */
    function send(value: Message): void {
      if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(value));
    }

    /** 只通过当前设备连接发送控制消息。 */
    function toLinx(value: Message): void {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ session_id: sessionId || undefined, ...value }));
    }

    /** 响应同一个工具请求并缓存结果，重复请求不会再次执行。 */
    function toolResult(key: string, text: string, failed = false): void {
      const item = pending.get(key);
      if (!item || item.result) return;
      clearTimeout(item.timer);
      item.result = { type: 'mcp', payload: { jsonrpc: '2.0', id: item.id, result: { content: [{ type: 'text', text }], isError: failed } } };
      toLinx(item.result);
    }

    /** 关闭网络、定时器和待执行请求，并通知页面取消本局动作。 */
    function cleanup(): void {
      if (closed) return;
      closed = true;
      for (const [key, item] of pending) {
        if (!item.result) toolResult(key, JSON.stringify({ status: 'cancelled', reason: 'connection_closed' }), true);
        clearTimeout(item.timer);
      }
      clearTimeout(roundTimer);
      clearTimeout(setupTimer);
      if (device) locked.delete(device);
      upstream?.close();
      if (browser.readyState === WebSocket.OPEN) browser.close();
    }

    /** 返回可诊断的英文错误码，详细凭证和上游响应不下发。 */
    function fail(code: string): void { send({ type: 'error', code }); cleanup(); }

    /** 设备握手和工具发现全部完成后才允许开局。 */
    function checkReady(): void {
      if (!helloReceived || !toolsDiscovered || ready) return;
      ready = true;
      clearTimeout(setupTimer);
      send({ type: 'ready', mode });
    }

    /** 在服务端建立虚拟设备，使用激活码绑定并获取上游地址。 */
    async function connect(identity: { device: string; client: string }): Promise<void> {
      if (!agentId) return fail('LINX_NOT_CONFIGURED');
      device = process.env.LINX_DEVICE_ID?.trim() || identity.device;
      if (locked.has(device)) { device = ''; return fail('DEVICE_IN_USE'); }
      locked.add(device);
      const headers = { 'Content-Type': 'application/json', 'Device-Id': device, 'Client-Id': identity.client, 'Activation-Version': '1', 'User-Agent': 'niuqiqi-web/0.1.0' };
      /** 获取设备网关信息，响应凭证仅在当前服务端会话使用。 */
      async function ota(): Promise<Message> {
        const response = await fetch('https://xrobo.qiniuapi.com/v1/ota/', {
          method: 'POST', headers, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ version: 0, mac_address: device, uuid: identity.client, application: { name: 'niuqiqi-web', version: '0.1.0', elf_sha256: '0'.repeat(64) }, board: { type: 'niuqiqi-web', ssid: '', rssi: 0 } }),
        });
        if (!response.ok) throw new Error('OTA_FAILED');
        return response.json() as Promise<Message>;
      }
      let info = await ota();
      if (closed) return;
      if (!info.websocket?.token && info.activation?.code) {
        if (!apiKey) {
          send({ type: 'activation', code: String(info.activation.code) });
          return cleanup();
        }
        const binding = await fetch(`https://xrobo.qiniu.com/xiaozhi/device/bind/${encodeURIComponent(agentId)}/${encodeURIComponent(info.activation.code)}`, {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000),
        });
        const result = await binding.json() as Message;
        if (closed) return;
        if (!binding.ok || result.code !== 0) throw new Error('DEVICE_BIND_FAILED');
        info = await ota();
      }
      if (!info.websocket?.token || !info.websocket?.url) throw new Error('DEVICE_NOT_BOUND');
      const url = new URL(info.websocket.url);
      if (!url.hostname.endsWith('.qiniuapi.com')) throw new Error('INVALID_UPSTREAM');
      url.protocol = 'wss:';
      if (closed) return;
      upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${info.websocket.token}`, 'Device-Id': device, 'Client-Id': identity.client, 'Protocol-Version': '1', 'X-Agent-ID': agentId }, handshakeTimeout: 10000 });
      upstream.on('open', () => toLinx({ type: 'hello', version: 1, transport: 'websocket', features: { mcp: true }, audio_params: { format: 'pcm', sample_rate: 16000, channels: 1, bit_depth: 16, endianness: 'little', frame_duration: 20, frame_size: 320, sample_format: 'signed_int16' } }));
      upstream.on('message', (data, binary) => {
        if (binary || closed) return;
        try { handleUpstream(JSON.parse(data.toString())); } catch { fail('INVALID_UPSTREAM_MESSAGE'); }
      });
      upstream.on('error', () => fail('LINX_CONNECTION_FAILED'));
      upstream.on('close', () => { if (!closed) fail('LINX_DISCONNECTED'); });
    }

    /** 处理服务端握手、文字和端侧工具协议。 */
    function handleUpstream(message: Message): void {
      if (message.type === 'hello') {
        sessionId = typeof message.session_id === 'string' ? message.session_id : '';
        helloReceived = true;
        checkReady();
      }
      if (message.type === 'stt' && typeof message.text === 'string') send({ type: 'transcript', text: message.text });
      if (message.type === 'tts' && message.state === 'sentence_start' && typeof message.text === 'string') send({ type: 'reply', text: message.text, roundId, mode });
      if (message.type !== 'mcp') return;
      const payload = message.payload ?? {};
      const id = payload.id;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      if (payload.method === 'initialize') {
        toLinx({ type: 'mcp', payload: { jsonrpc: '2.0', id, result: { protocolVersion: payload.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'niuqiqi-web', version: '0.1.0' } } } });
      } else if (payload.method === 'tools/list') {
        toLinx({ type: 'mcp', payload: { jsonrpc: '2.0', id, result: { tools } } });
        toolsDiscovered = true;
        checkReady();
      } else if (payload.method === 'tools/call') {
        const key = `${typeof id}:${id}`;
        const cached = pending.get(key);
        if (cached) { if (cached.result) toLinx(cached.result); return; }
        pending.set(key, { id, name: payload.params?.name });
        const args = payload.params?.arguments ?? {};
        if (!args || typeof args !== 'object' || !validTool(payload.params?.name, args)) return toolResult(key, 'Invalid tool or arguments', true);
        const toolName = payload.params?.name;
        if (toolName === 'self.niuqiqi.start_apple_game') {
          if (mode !== 'chat') return toolResult(key, 'Game is already running', true);
          mode = 'apple-game';
          roundId = randomUUID();
          deadline = Date.now() + 180_000;
          send({ type: 'round', roundId, endsAt: deadline, serverNow: Date.now(), mode });
          clearTimeout(roundTimer);
          roundTimer = setTimeout(() => {
            send({ type: 'finished', roundId, mode: 'apple-game' });
            mode = 'chat';
            deadline = 0;
            send({ type: 'mode', mode });
          }, 180_000);
        } else if (toolName === 'self.niuqiqi.exit_apple_game') {
          if (mode !== 'apple-game') return toolResult(key, 'Game is not running', true);
          mode = 'chat';
          deadline = 0;
          send({ type: 'mode', mode });
        } else if (toolName === 'self.niuqiqi.do_action') {
          if (!canPerformAction(mode, args.action)) return toolResult(key, 'Action is unavailable in the current mode', true);
          if (mode === 'apple-game' && (!roundId || Date.now() >= deadline)) return toolResult(key, 'Game is not running', true);
        }
        // 最长舞蹈约 8.17 秒，保留传输余量，避免六秒时误取消。
        const toolTimeoutMs = toolName === 'self.niuqiqi.do_action' && mode === 'chat' && args.action === 'dance' ? 12000 : 6000;
        pending.get(key)!.timer = setTimeout(() => {
          toolResult(key, 'Tool execution timed out', true);
          send({ type: 'cancel', requestId: key, roundId });
          if (toolName === 'self.niuqiqi.start_apple_game') {
            mode = 'chat';
            deadline = 0;
            clearTimeout(roundTimer);
            send({ type: 'mode', mode });
          }
        }, toolTimeoutMs);
        send({ type: 'tool', requestId: key, roundId, name: payload.params.name, args });
      } else if (payload.method !== undefined) {
        toLinx({ type: 'mcp', payload: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } } });
      }
    }

    browser.on('message', (data, binary) => {
      if (closed) return;
      if (binary) {
        if (listening && (mode === 'chat' || deadline > Date.now()) && upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: true });
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as Message;
        if (message.type === 'result') {
          if (message.requestId === undefined || (message.roundId && message.roundId !== roundId)) return;
          if (!pending.has(message.requestId)) return;
          const pendingItem = pending.get(message.requestId);
          toolResult(message.requestId, JSON.stringify(message.result), !!message.failed);
          if (pendingItem?.name === 'self.niuqiqi.start_apple_game' && message.failed) {
            mode = 'chat';
            deadline = 0;
            clearTimeout(roundTimer);
            send({ type: 'mode', mode });
          }
        } else if (message.type === 'speech.start' || message.type === 'speech.stop') {
          if (!ready) return;
          if (message.type === 'speech.start') {
            listening = true;
            toLinx({ type: 'abort', reason: 'wake_word_detected' });
            toLinx({ type: 'listen', state: 'start', mode: 'manual' });
          } else {
            listening = false;
            toLinx({ type: 'listen', state: 'stop', mode: 'manual' });
          }
        } else if (message.roundId === roundId && roundId && mode === 'apple-game' && Date.now() < deadline) {
          if (message.type === 'text' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 2000) {
            // 当前按官方带文本的 detect 示例接入，仍需真实账号验证工具触发行为。
            toLinx({ type: 'listen', state: 'detect', text: message.text });
          }
        }
      } catch { send({ type: 'error', code: 'INVALID_CLIENT_MESSAGE' }); }
    });
    browser.on('close', cleanup);
    browser.on('error', cleanup);
    setupTimer = setTimeout(() => fail('LINX_SETUP_TIMEOUT'), 40000);
    const cookie = request.headers.cookie?.match(/(?:^|;\s*)nqq_device=([a-f0-9]{48})(?:;|$)/)?.[1];
    if (!cookie || !sessions.has(cookie)) return fail('SESSION_REQUIRED');
    void connect(sessions.get(cookie)!).catch((error) => fail(['OTA_FAILED', 'DEVICE_BIND_FAILED', 'DEVICE_NOT_BOUND', 'INVALID_UPSTREAM'].includes(error.message) ? error.message : 'LINX_SETUP_FAILED'));
  });

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const http = createServer((request, response) => void handleRequest(request, response));
  attachGateway(http);
  http.on('error', () => { console.error('Gateway listen failed'); process.exitCode = 1; });
  http.listen(port, '127.0.0.1', () => console.info(`Niuqiqi gateway listening on http://127.0.0.1:${port}`));
}
