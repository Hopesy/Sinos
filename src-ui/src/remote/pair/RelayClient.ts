import { RemoteClient, RemoteError, type RemoteSocket } from '../client';
import { openFrame, sealFrame, generateContentKey, boxContentKey } from './crypto';
import { fromBase64Url, toBase64Url } from './encoding';
import { ResponseChunks, type ResponseChunk } from './responseChunks';
import { checkDeviceStorage, saveDevice, validateInvite, type PairedDevice } from './deviceStorage';
import { isAndroidApp } from '../native/bridge';
import { NativeRelaySocket, type RelaySocket } from '../native/NativeRelaySocket';
export { savedDevice, forgetDevice, type PairedDevice } from './deviceStorage';

export async function claimDevice(link: string, name: string): Promise<PairedDevice> {
  const invite = validateInvite(link);
  const relay = new URL(invite.relay);
  // Check durable storage before consuming the single-use invitation.
  await checkDeviceStorage();
  const key = generateContentKey();
  const boxed = boxContentKey(key, invite.publicKey);
  const response = await fetch(`${relay.origin}/v1/pair/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ publicKey: toBase64Url(invite.publicKey), boxedKey: [boxed.ephPublicKey, boxed.nonce, boxed.boxed].map(toBase64Url).join('.'), deviceName: name.trim().slice(0, 60) || '手机' }),
  });
  if (!response.ok) throw new Error(response.status === 409 || response.status === 410 ? '配对邀请已使用或过期，请在电脑上重新生成。' : '配对未完成，请检查网络后重试。');
  const result = await response.json() as { pairId: string; deviceToken: string };
  if (!/^[\w-]{22}$/.test(result.pairId) || typeof result.deviceToken !== 'string' || !result.deviceToken) throw new Error('中继响应不正确。');
  const device = { pairId: result.pairId, token: result.deviceToken, relay: relay.origin, contentKey: toBase64Url(key), name };
  await saveDevice(device);
  history.replaceState(null, '', location.pathname);
  return device;
}

interface Reply extends ResponseChunk { type: string; protocol?: string; channel?: string; id?: string; status?: number; data?: unknown; error?: string }
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void; chunks?: ResponseChunks }

export class RelayClient extends RemoteClient {
  private ws?: RelaySocket;
  private channel = '';
  private seq = 0;
  private stopped = false;
  private revoked = false;
  private replaced = false;
  private paused = false;
  private attempt = 0;
  private pending = new Map<string, Pending>();
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastSeen = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();
  private key: Uint8Array;
  readonly device: PairedDevice;
  constructor(device: PairedDevice) {
    super(device.relay, ''); this.device = device; this.key = fromBase64Url(device.contentKey);
    this.connect(); window.addEventListener('online', this.wake); document.addEventListener('visibilitychange', this.wake);
  }
  private wake = () => { if (!document.hidden && (!this.ws || this.ws.readyState > 1)) { clearTimeout(this.retry); this.connect(); } };
  dispose() {
    this.stopped = true; clearTimeout(this.retry); clearInterval(this.heartbeat); this.ws?.close(); this.failPending();
    window.removeEventListener('online', this.wake); document.removeEventListener('visibilitychange', this.wake);
  }
  private failPending() {
    this.channel = '';
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(new RemoteError(this.revoked ? 401 : this.paused ? 409 : 503, this.paused ? 'CONNECTION_PAUSED' : 'DISCONNECTED')); }
    this.pending.clear();
  }
  private connect() {
    if (this.stopped || this.revoked || this.replaced || this.paused || (this.ws && this.ws.readyState < 2)) return;
    const url = new URL(`/v1/pair/${this.device.pairId}`, this.device.relay);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('role', 'guest'); url.searchParams.set('token', this.device.token);
    this.ws?.close();
    const socket = isAndroidApp ? new NativeRelaySocket(url) : new WebSocket(url);
    if (socket instanceof WebSocket) socket.binaryType = 'arraybuffer';
    const ws = this.ws = socket as RelaySocket;
    const connectDeadline = isAndroidApp ? undefined : setTimeout(() => { if (ws.readyState === 0) ws.close(); }, 12000);
    ws.onopen = () => {
      clearTimeout(connectDeadline);
      this.lastSeen = Date.now(); clearInterval(this.heartbeat);
      if (!isAndroidApp) this.heartbeat = setInterval(() => { if (Date.now() - this.lastSeen > 25000) ws.close(); else if (ws.readyState === 1) ws.send('ping'); }, 10000);
    };
    ws.onmessage = (event) => {
      this.lastSeen = Date.now();
      this.receiveQueue = this.receiveQueue.then(async () => {
        if (ws !== this.ws || this.stopped) return;
        if (typeof event.data === 'string') {
          if (event.data === 'pong') return;
          const control = JSON.parse(event.data) as Reply;
          if (control.type === 'revoked') { this.revoked = true; this.failPending(); ws.close(); }
          if (control.type === 'peer-left' || control.type === 'host-offline') this.failPending();
          return;
        }
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 1048576) return;
        let frame = await openFrame(this.key, new Uint8Array(event.data)) as Reply;
        if (ws !== this.ws || this.stopped) return;
        if (frame.type === 'hello' && frame.protocol === 'coffee-v1' && frame.channel) {
          this.failPending(); this.channel = frame.channel; this.seq = 0; this.attempt = 0; return;
        }
        if (frame.channel !== this.channel || !frame.id) return;
        const item = this.pending.get(frame.id); if (!item) return;
        if (frame.type === 'response-chunk') {
          const id = frame.id;
          try {
            const complete = (item.chunks ??= new ResponseChunks()).push(frame) as Reply | null;
            if (!complete) return;
            if (complete.id !== id || complete.channel !== this.channel || complete.type !== 'response') throw new Error('INVALID_RESPONSE');
            frame = complete;
          } catch {
            clearTimeout(item.timer); item.cleanup(); this.pending.delete(id);
            item.reject(new RemoteError(502, 'INVALID_RESPONSE')); return;
          }
        }
        if (frame.type !== 'response' || !frame.id) return;
        clearTimeout(item.timer); item.cleanup(); this.pending.delete(frame.id);
        if ((frame.status || 500) >= 400) item.reject(new RemoteError(frame.status || 500, frame.error || 'REQUEST_FAILED'));
        else item.resolve(frame.data);
      }).catch(() => { /* Invalid or forged frames never reach application handlers. */ });
    };
    ws.onclose = (event) => {
      clearTimeout(connectDeadline);
      if (ws !== this.ws) return;
      if (event.code === 1008) this.revoked = true;
      if (event.code === 1000 && event.reason === 'replaced') this.replaced = true;
      if (event.code === 4000) this.paused = true;
      clearInterval(this.heartbeat); this.failPending();
      if (!this.stopped && !this.revoked && !this.replaced && !this.paused && ws.readyState !== 0) this.retry = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** this.attempt++) + Math.random() * 300);
    };
  }
  pauseConnection() { this.paused = true; clearTimeout(this.retry); clearInterval(this.heartbeat); this.ws?.close(); this.failPending(); }
  resumeHere() { if (!this.stopped && !this.revoked) { this.replaced = false; this.paused = false; this.attempt = 0; clearTimeout(this.retry); this.connect(); } }
  rpc<T>(action: string, sessionId = '', params: unknown = {}, signal?: AbortSignal): Promise<T> {
    if (this.paused) return Promise.reject(new RemoteError(409, 'CONNECTION_PAUSED'));
    if (this.replaced) return Promise.reject(new RemoteError(409, 'CONNECTION_REPLACED'));
    if (!this.channel || this.ws?.readyState !== 1 || signal?.aborted) return Promise.reject(new RemoteError(this.revoked ? 401 : 503, 'COMPUTER_OFFLINE'));
    if (this.pending.size >= 32) return Promise.reject(new RemoteError(429, 'TOO_MANY_REQUESTS'));
    const id = crypto.randomUUID(), channel = this.channel, ws = this.ws;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { const item = this.pending.get(id); if (item) { clearTimeout(item.timer); item.cleanup(); this.pending.delete(id); reject(new RemoteError(408, 'REQUEST_CANCELLED')); } };
      const timer = setTimeout(abort, 20000);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) });
      this.sendQueue = this.sendQueue.then(async () => {
        if (!this.pending.has(id)) return;
        if (channel !== this.channel || ws !== this.ws) { abort(); return; }
        const frame = await sealFrame(this.key, { type: 'request', id, channel, seq: ++this.seq, acceptChunks: true, action, sessionId, params });
        if (frame.length > 1048576) {
          const item = this.pending.get(id);
          if (item) { clearTimeout(item.timer); item.cleanup(); this.pending.delete(id); item.reject(new RemoteError(413, 'REQUEST_TOO_LARGE')); }
          return;
        }
        if (this.pending.has(id) && channel === this.channel && ws.readyState === 1) ws.send(frame);
        else abort();
      }).catch(abort);
    });
  }
  override request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const match = /^\/api\/sessions\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const routes: Record<string, string> = { images: 'session.images', input: 'session.input', prompt: 'session.prompt', answer: 'session.answer', queue: init.method === 'POST' ? 'session.queue_action' : 'session.queue', pause: 'session.pause', kill: 'session.kill', chat: 'session.chat', directory: 'workspace.list', file: init.method === 'POST' ? 'workspace.save' : 'workspace.read', changes: 'workspace.changes', diff: 'workspace.diff' };
    const action = match ? routes[match[2]] : ({ '/api/state': 'state', '/api/tools': 'tools', '/api/launch': 'session.launch' } as Record<string, string>)[url.pathname];
    if (!action) return Promise.reject(new RemoteError(400, 'UNKNOWN_ACTION'));
    const params = { ...Object.fromEntries(url.searchParams), ...(typeof init.body === 'string' ? JSON.parse(init.body) as object : {}) };
    return this.rpc<T>(action, match ? decodeURIComponent(match[1]) : '', params, init.signal || undefined);
  }
  override socket(id: string): RemoteSocket { return new RelayTerminalSocket(this, id); }
}

class RelayTerminalSocket implements RemoteSocket {
  readyState = 0;
  onopen: RemoteSocket['onopen'] = null;
  onmessage: RemoteSocket['onmessage'] = null;
  onclose: RemoteSocket['onclose'] = null;
  onerror: RemoteSocket['onerror'] = null;
  private offset = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private client: RelayClient;
  private id: string;
  constructor(client: RelayClient, id: string) { this.client = client; this.id = id; this.timer = setTimeout(() => void this.poll(), 0); }
  private async poll() {
    if (this.readyState > 1) return;
    try {
      const result = await this.client.rpc<{ data: string; offset: number; running: boolean; paused: boolean; reset: boolean }>('terminal.read', this.id, { offset: this.offset });
      if (this.readyState > 1) return;
      if (this.readyState === 0) { this.readyState = 1; this.onopen?.(new Event('open')); }
      this.offset = result.offset;
      if (result.reset) this.emit({ type: 'reset' });
      if (result.data) this.emit({ type: 'output', session_id: this.id, data: result.data, sequence: result.offset });
      this.emit({ type: 'status', session_id: this.id, running: result.running, paused: result.paused });
      this.timer = setTimeout(() => void this.poll(), document.hidden ? 1500 : 200);
    } catch { this.onerror?.(new Event('error')); this.close(); }
  }
  private emit(data: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) })); }
  send(data: string) {
    const message = JSON.parse(data) as { type: string; data?: string; cols?: number; rows?: number };
    const action = message.type === 'resize' ? 'terminal.resize' : 'session.input';
    void this.client.rpc(action, this.id, message).catch(() => this.onerror?.(new Event('error')));
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; clearTimeout(this.timer); this.onclose?.(new CloseEvent('close')); }
}
