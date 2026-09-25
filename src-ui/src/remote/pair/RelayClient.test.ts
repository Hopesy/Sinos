// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RelayClient } from './RelayClient';
import { toBase64Url } from './encoding';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  onopen?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;
  constructor() { FakeSocket.instances.push(this); }
  send() {}
  open() { this.readyState = 1; this.onopen?.(); }
  close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
}
let client: RelayClient;
beforeEach(() => {
  vi.useFakeTimers(); FakeSocket.instances = []; vi.stubGlobal('WebSocket', FakeSocket);
  client = new RelayClient({ pairId: 'a'.repeat(22), relay: 'https://relay.example', token: 'test', contentKey: toBase64Url(new Uint8Array(32)), name: 'test' });
});
afterEach(() => { client.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('carries Claude cursors independently and restarts its replay after reconnect', async () => {
  const page = { epoch: 'claude-epoch', cursor: 9, reset: true, online: true, complete: true, has_more: false, thread_id: 'session', events: [] };
  const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ data: '', offset: 2, running: true, paused: false, reset: false, claude: page });
  const socket = client.socket('terminal'), receive = vi.fn(); socket.onmessage = receive;
  await vi.advanceTimersByTimeAsync(1);
  expect(receive.mock.calls.map(([frame]) => JSON.parse(frame.data).type)).toContain('claude');
  await vi.advanceTimersByTimeAsync(1600);
  expect(rpc).toHaveBeenLastCalledWith('terminal.read', 'terminal', expect.objectContaining({ claudeEpoch: 'claude-epoch', claudeCursor: 9 }));
  socket.close();
  const reconnect = client.socket('terminal'); await vi.advanceTimersByTimeAsync(1);
  expect(rpc).toHaveBeenLastCalledWith('terminal.read', 'terminal', { offset: 0, codexEpoch: undefined, codexCursor: 0 });
  reconnect.close();
});

it('carries incremental Codex cursors through the existing relay and starts a reconnect from a clean snapshot', async () => {
  const page = { epoch: 'epoch', cursor: 7, reset: true, online: true, complete: true, thread_id: 'root', events: [] };
  const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ data: '', offset: 10, running: true, paused: false, reset: false, codex: page });
  const socket = client.socket('terminal');
  const receive = vi.fn(); socket.onmessage = receive;
  await vi.advanceTimersByTimeAsync(1);
  expect(receive.mock.calls.map(([frame]) => JSON.parse(frame.data).type)).toContain('codex');
  await vi.advanceTimersByTimeAsync(1600);
  expect(rpc).toHaveBeenLastCalledWith('terminal.read', 'terminal', { offset: 10, codexEpoch: 'epoch', codexCursor: 7 });
  socket.close();
  const reconnected = client.socket('terminal');
  await vi.advanceTimersByTimeAsync(1);
  expect(rpc).toHaveBeenLastCalledWith('terminal.read', 'terminal', { offset: 0, codexEpoch: undefined, codexCursor: 0 });
  reconnected.close();
});

it('does not fight another tab for the same connection, and resumes only on request', async () => {
  FakeSocket.instances[0].open();
  FakeSocket.instances[0].close(1000, 'replaced');
  await vi.advanceTimersByTimeAsync(31000);
  expect(FakeSocket.instances).toHaveLength(1);
  await expect(client.rpc('state')).rejects.toMatchObject({ status: 409, message: 'CONNECTION_REPLACED' });
  client.resumeHere();
  expect(FakeSocket.instances).toHaveLength(2);
  FakeSocket.instances[1].close(1008, 'revoked');
  client.resumeHere();
  await vi.advanceTimersByTimeAsync(31000);
  expect(FakeSocket.instances).toHaveLength(2);
  await expect(client.rpc('state')).rejects.toMatchObject({ status: 401 });
});

it('still reconnects automatically after an ordinary network interruption', async () => {
  FakeSocket.instances[0].open();
  FakeSocket.instances[0].close(1006);
  await vi.advanceTimersByTimeAsync(1500);
  expect(FakeSocket.instances).toHaveLength(2);
});

it('routes image chunks over the paired encrypted RPC instead of a separate upload origin', async () => {
  const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ received: 3, image: null });
  await client.images('session', { action: 'upload', id: 'image-id', offset: 0, total: 3, data_base64: 'YWJj' });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('session.images', 'session', { action: 'upload', id: 'image-id', offset: 0, total: 3, data_base64: 'YWJj' }, undefined);
});
