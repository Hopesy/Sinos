// Exercise the real local Workers + Durable Objects runtime, not a mock room.
// Start `npm run dev` first. All keys are disposable test credentials.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { generatePairKeypair, generateContentKey, boxContentKey, openBoxedContentKey, sealFrame, openFrame } from '../../src-ui/src/remote/pair/crypto';
import { toBase64Url, fromBase64Url } from '../../src-ui/src/remote/pair/encoding';

const origin = process.env.RELAY_TEST_URL || 'http://127.0.0.1:8788';
const sockets: WebSocket[] = [];
async function post(path: string, data: unknown) { return fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
async function socket(id: string, role: string, token: string) {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/pair/${id}?role=${role}&token=${token}`);
  sockets.push(ws); await once(ws, 'open'); return ws;
}
async function binary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('binary frame timeout')); }, 4000);
    const listener = (data: Buffer, isBinary: boolean) => { if (!isBinary) return; clearTimeout(timer); ws.off('message', listener); resolve(new Uint8Array(data)); };
    ws.on('message', listener);
  });
}
try {
  // Cancellation is owner-only and invalidates both claim and delayed polls.
  const cancelledHost = generatePairKeypair();
  const cancelledPublicKey = toBase64Url(cancelledHost.publicKey), cancelledOwner = toBase64Url(generateContentKey());
  assert.equal((await post('/v1/pair/request', { publicKey: cancelledPublicKey, requestToken: cancelledOwner, pollOnly: true })).status, 410);
  assert.equal((await post('/v1/pair/request', { publicKey: cancelledPublicKey, requestToken: cancelledOwner })).status, 200);
  assert.equal((await post('/v1/pair/cancel', { publicKey: cancelledPublicKey, requestToken: toBase64Url(generateContentKey()) })).status, 403);
  assert.equal((await post('/v1/pair/cancel', { publicKey: cancelledPublicKey, requestToken: cancelledOwner })).status, 200);
  const cancelledBox = boxContentKey(generateContentKey(), cancelledHost.publicKey);
  const cancelledPayload = [cancelledBox.ephPublicKey, cancelledBox.nonce, cancelledBox.boxed].map(toBase64Url).join('.');
  assert.equal((await post('/v1/pair/request', { publicKey: cancelledPublicKey, requestToken: cancelledOwner, pollOnly: true })).status, 410);
  assert.equal((await post('/v1/pair/claim', { publicKey: cancelledPublicKey, boxedKey: cancelledPayload })).status, 409);
  const host = generatePairKeypair(), key = generateContentKey();
  const publicKey = toBase64Url(host.publicKey), requestToken = toBase64Url(generateContentKey());
  const created = await post('/v1/pair/request', { publicKey, requestToken });
  assert.equal(created.status, 200); const { pairId } = await created.json() as { pairId: string };
  assert.equal((await post('/v1/pair/request', { publicKey, requestToken: toBase64Url(generateContentKey()) })).status, 403);
  assert.equal((await post('/v1/pair/claim', { publicKey, boxedKey: 'invalid' })).status, 400);
  const box = boxContentKey(key, host.publicKey);
  const boxedKey = [box.ephPublicKey, box.nonce, box.boxed].map(toBase64Url).join('.');
  const claim = await post('/v1/pair/claim', { publicKey, boxedKey, deviceName: 'integration-phone' });
  assert.equal(claim.status, 200); const { deviceToken } = await claim.json() as { deviceToken: string };
  assert.equal((await post('/v1/pair/claim', { publicKey, boxedKey })).status, 409);
  const authorized = await (await post('/v1/pair/request', { publicKey, requestToken })).json() as { hostToken: string; response: string };
  const parts = authorized.response.split('.').map(fromBase64Url);
  assert.deepEqual(openBoxedContentKey({ ephPublicKey: parts[0], nonce: parts[1], boxed: parts[2] }, host.secretKey), key);
  const hs = await socket(pairId, 'host', authorized.hostToken);
  const gs = await socket(pairId, 'guest', deviceToken);
  const guestRead = binary(gs);
  hs.send(await sealFrame(key, { type: 'hello', protocol: 'coffee-v1', channel: 'test' }));
  assert.deepEqual(await openFrame(key, await guestRead), { type: 'hello', protocol: 'coffee-v1', channel: 'test' });
  const hostRead = binary(hs);
  gs.send(await sealFrame(key, { type: 'request', text: '手机发送中文', id: 'one' }));
  assert.deepEqual(await openFrame(key, await hostRead), { type: 'request', text: '手机发送中文', id: 'one' });
  const pong = once(gs, 'message'); gs.send('ping'); assert.equal(String((await pong)[0]), 'pong');
  const closedGuest = once(gs, 'close'), closedHost = once(hs, 'close');
  assert.equal((await fetch(`${origin}/v1/pair/${pairId}?token=wrong`, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(`${origin}/v1/pair/${pairId}?token=${authorized.hostToken}`, { method: 'DELETE' })).status, 200);
  assert.equal((await closedGuest)[0], 1008); assert.equal((await closedHost)[0], 1008);
  const invalid = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/pair/${pairId}?role=guest&token=${deviceToken}`);
  sockets.push(invalid); assert.equal((await once(invalid, 'close'))[0], 1008);
  console.log('PASS: owner-bound cancellation, no poll resurrection, single-use claim, NaCl exchange, AES-GCM forwarding, heartbeat, revoke, stale credential rejection');
} finally { for (const ws of sockets) ws.terminate(); }
