import { beforeEach, expect, it, vi } from 'vitest';
import type { SocketEvent } from './bridge';
const native = vi.hoisted(() => ({ addListener: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), remove: vi.fn() }));
vi.mock('./bridge', () => ({ SinosMobile: native }));
import { NativeRelaySocket } from './NativeRelaySocket';
let receive: (event: SocketEvent) => void;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.clearAllMocks();
  native.addListener.mockImplementation(async (_event, callback) => { receive = callback; return { remove: native.remove }; });
  native.connect.mockResolvedValue(undefined); native.disconnect.mockResolvedValue(undefined); native.send.mockResolvedValue(undefined);
});
it('keeps reconnecting ownership native and accepts the fresh handshake after a network change', async () => {
  const socket = new NativeRelaySocket(new URL('wss://relay.example/v1/pair/test'));
  const opened = socket.onopen = vi.fn(), closed = socket.onclose = vi.fn(), message = socket.onmessage = vi.fn();
  await settle(); const { id } = native.connect.mock.calls[0][0];
  receive({ id, type: 'open' }); expect(socket.readyState).toBe(1);
  receive({ id, type: 'close', retrying: true, code: 1006 }); expect(socket.readyState).toBe(0);
  receive({ id, type: 'open' }); receive({ id, type: 'binary', data: btoa('hello') });
  expect(opened).toHaveBeenCalledTimes(2); expect(closed).toHaveBeenCalledOnce();
  expect(new Uint8Array(message.mock.calls[0][0].data)).toEqual(new TextEncoder().encode('hello'));
  receive({ id: 'stale-session', type: 'close' }); expect(socket.readyState).toBe(1);
  receive({ id, type: 'close', code: 4000, reason: 'paused' }); expect(socket.readyState).toBe(3);
  socket.close();
});
it('cannot resurrect a disposed socket after async listener registration', async () => {
  const socket = new NativeRelaySocket(new URL('wss://relay.example'));
  socket.close(); await settle();
  expect(native.connect).not.toHaveBeenCalled(); expect(native.remove).toHaveBeenCalledOnce();
});
it('sends large ciphertext without overflowing the JS argument stack', async () => {
  const socket = new NativeRelaySocket(new URL('wss://relay.example')); await settle();
  const bytes = new Uint8Array(1024 * 1024); bytes[bytes.length - 1] = 255;
  socket.send(bytes);
  const frame = native.send.mock.calls[0][0]; expect(frame.binary).toBe(true);
  expect(atob(frame.data).charCodeAt(bytes.length - 1)).toBe(255);
  socket.close();
});
