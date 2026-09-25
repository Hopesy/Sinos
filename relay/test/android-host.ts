// Disposable encrypted host for Android lifecycle testing. Never touches local projects.
// RELAY_TEST_URL must point at a test/deployed relay; the invitation is written to
// target/android-test/invite.txt, not included in logs. Type quit to revoke it.
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePairKeypair, generateContentKey, openBoxedContentKey, sealFrame, openFrame } from '../../src-ui/src/remote/pair/crypto';
import { toBase64Url, fromBase64Url } from '../../src-ui/src/remote/pair/encoding';

const origin = process.env.RELAY_TEST_URL;
if (!origin || !origin.startsWith('https://')) throw new Error('Set RELAY_TEST_URL to an HTTPS relay');
const directory = resolve(import.meta.dirname, '../../target/android-test'); mkdirSync(directory, { recursive: true });
const host = generatePairKeypair(), publicKey = toBase64Url(host.publicKey), requestToken = toBase64Url(generateContentKey());
async function request(pollOnly = false) {
  const response = await fetch(`${origin}/v1/pair/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, requestToken, pollOnly }) });
  if (!response.ok) throw new Error(`Pair request: ${response.status}`);
  return response.json() as Promise<{ pairId: string; state: string; hostToken?: string; response?: string }>;
}
await request();
writeFileSync(resolve(directory, 'invite.txt'), `${origin}/#pk=${publicKey}`);
console.log('Disposable invitation ready in target/android-test/invite.txt');
let result: Awaited<ReturnType<typeof request>> | undefined;
for (let i = 0; i < 120; i++) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const next = await request(true); if (next.state === 'authorized') { result = next; break; }
}
if (!result?.response) throw new Error('Invitation expired');
const [ephPublicKey, nonce, boxed] = result.response.split('.').map(fromBase64Url);
const key = openBoxedContentKey({ ephPublicKey, nonce, boxed }, host.secretKey);
const ws = new WebSocket(`${origin.replace('https:', 'wss:')}/v1/pair/${result.pairId}?role=host&token=${result.hostToken}`);
let channel = '', seq = 0, joins = 0, requests = 0;
let queue = Promise.resolve();
ws.on('message', (bytes, binary) => {
  queue = queue.then(async () => {
    if (!binary) {
      if (String(bytes) === 'pong') return;
      const control = JSON.parse(String(bytes));
      if (control.type === 'peer-joined') {
        channel = crypto.randomUUID(); seq = 0; joins++;
        ws.send(await sealFrame(key, { type: 'hello', protocol: 'coffee-v1', channel }));
        console.log(`Guest connected; handshake ${joins}`);
      }
      if (control.type === 'peer-left') console.log('Guest disconnected');
      return;
    }
    const message = await openFrame(key, new Uint8Array(bytes as Buffer)) as { channel: string; seq: number; action: string; id: string };
    if (message.channel !== channel || message.seq <= seq) throw new Error('stale channel or replay');
    seq = message.seq; requests++;
    const data = message.action === 'state' ? { device_name: 'Android lifecycle test', sessions: [], capabilities: [] } : message.action === 'tools' ? [] : null;
    ws.send(await sealFrame(key, { type: 'response', channel, id: message.id, status: data === null ? 400 : 200, data }));
    writeFileSync(resolve(directory, 'metrics.json'), JSON.stringify({ joins, requests, lastRequest: Date.now() }));
  }).catch(error => console.error('Fixture protocol error:', error.message));
});
ws.on('error', () => console.error('Fixture connection failed'));
const heartbeat = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 10000);
let stopped = false;
async function stop() {
  if (stopped) return; stopped = true; clearInterval(heartbeat);
  await fetch(`${origin}/v1/pair/${result!.pairId}?token=${result!.hostToken}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
  ws.terminate(); console.log('Disposable pairing revoked.'); process.exit(0);
}
process.stdin.on('data', value => { if (String(value).trim() === 'quit') void stop(); });
process.on('SIGINT', () => void stop());
setTimeout(() => void stop(), 1800000);
console.log('Encrypted Android fixture online. Type quit to revoke.');
