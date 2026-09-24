// Disposable desktop simulator for checking the actual phone/relay protocol.
// Requires `npm run dev` and src-ui/scripts/mobile-preview.mjs on loopback.
import { WebSocket } from 'ws';
import { generatePairKeypair, generateContentKey, openBoxedContentKey, sealFrame, openFrame } from '../../src-ui/src/remote/pair/crypto';
import { toBase64Url, fromBase64Url } from '../../src-ui/src/remote/pair/encoding';

const origin = process.env.RELAY_TEST_URL || 'http://127.0.0.1:8788';
const host = generatePairKeypair();
const publicKey = toBase64Url(host.publicKey), requestToken = toBase64Url(generateContentKey());
async function request(pollOnly = false) {
  const response = await fetch(`${origin}/v1/pair/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey, requestToken, pollOnly }) });
  if (!response.ok) throw new Error(`Pair request failed: ${response.status}`);
  return response.json() as Promise<{ pairId: string; state: string; hostToken?: string; response?: string }>;
}
await request();
console.log(`Disposable test pairing: ${origin}/#pk=${publicKey}`);
const expires = Date.now() + 60000;
while (Date.now() < expires) {
  await new Promise(resolve => setTimeout(resolve, 800));
  const result = await request(true); if (result.state !== 'authorized') continue;
  const [ephPublicKey, nonce, boxed] = result.response!.split('.').map(fromBase64Url);
  const key = openBoxedContentKey({ ephPublicKey, nonce, boxed }, host.secretKey);
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/v1/pair/${result.pairId}?role=host&token=${result.hostToken}`);
  let channel = crypto.randomUUID(), seq = 0;
  let queue = Promise.resolve();
  ws.on('message', (bytes, binary) => {
    queue = queue.then(async () => {
      if (!binary) {
        if (String(bytes) === 'pong') return;
        const control = JSON.parse(String(bytes));
        if (control.type === 'peer-joined') { channel = crypto.randomUUID(); seq = 0; ws.send(await sealFrame(key, { type: 'hello', protocol: 'coffee-v1', channel })); }
        return;
      }
      const request = await openFrame(key, new Uint8Array(bytes as Buffer)) as { type: string; channel: string; seq: number; action: string; sessionId: string; params: Record<string, string>; id: string; acceptChunks?: boolean };
      if (request.channel !== channel || request.seq <= seq) return; seq = request.seq;
      const session = `/api/sessions/${encodeURIComponent(request.sessionId)}`;
      const route: Record<string, string> = { state: '/api/state', tools: '/api/tools', 'session.launch': '/api/launch', 'session.prompt': `${session}/prompt`, 'session.input': `${session}/input`, 'session.pause': `${session}/pause`, 'session.kill': `${session}/kill`, 'session.chat': `${session}/chat`, 'workspace.list': `${session}/directory`, 'workspace.read': `${session}/file`, 'workspace.save': `${session}/file`, 'workspace.changes': `${session}/changes`, 'workspace.diff': `${session}/diff` };
      const write = ['session.launch', 'session.prompt', 'session.input', 'session.pause', 'session.kill', 'workspace.save'].includes(request.action);
      if (!route[request.action]) { ws.send(await sealFrame(key, { type: 'response', id: request.id, channel, status: 400, error: 'UNSUPPORTED_FIXTURE_ACTION' })); return; }
      const url = new URL(route[request.action], 'http://127.0.0.1:5174');
      for (const field of ['path', 'cursor', 'revision', 'before']) if (request.params[field] != null) url.searchParams.set(field, String(request.params[field]));
      const response = await fetch(url, { method: write ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: write ? JSON.stringify(request.params) : undefined });
      let data = response.status === 204 ? null : await response.json();
      if (process.env.RELAY_FIXTURE_LARGE === '1' && request.action === 'workspace.read') data = { ...data, content: '\\'.repeat(524288), size: 524288 };
      const reply = { type: 'response', id: request.id, channel, status: response.status, data, error: response.ok ? undefined : JSON.stringify(data) };
      const encoded = new TextEncoder().encode(JSON.stringify(reply));
      if (encoded.length + 29 <= 1048576) ws.send(await sealFrame(key, reply));
      else if (request.acceptChunks) {
        const size = 192 * 1024, total = Math.ceil(encoded.length / size);
        for (let index = 0; index < total; index++) ws.send(await sealFrame(key, { type: 'response-chunk', id: request.id, channel, index, total, data: toBase64Url(encoded.subarray(index * size, (index + 1) * size)) }));
        console.log(`Forwarded large fixture response in ${total} encrypted parts.`);
      } else ws.send(await sealFrame(key, { type: 'response', id: request.id, channel, status: 413, error: 'RESPONSE_TOO_LARGE' }));
    }).catch(error => console.error('Fixture request failed:', error.message));
  });
  const timer = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 10000);
  let stopping = false;
  async function stop() {
    if (stopping) return; stopping = true; clearInterval(timer);
    try {
      await fetch(`${origin}/v1/pair/${result.pairId}?token=${result.hostToken}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
      console.log('Disposable fixture pairing revoked.');
    } finally { ws.terminate(); process.exit(0); }
  }
  setTimeout(() => void stop(), 300000);
  process.stdin.on('data', bytes => { if (String(bytes).trim() === 'quit') void stop(); });
  process.on('SIGINT', () => void stop());
  ws.on('close', () => void stop());
  console.log('Local fixture host paired. No real project or process is controlled.');
  break;
}
