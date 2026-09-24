// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteClient, RemoteError, readPairingToken } from './client';

beforeEach(() => { localStorage.clear(); window.history.replaceState(null, '', '/remote/'); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('consumes the QR fragment even when persistent storage is blocked', () => {
  window.history.replaceState(null, '', '/remote/#pair=test-pair');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readPairingToken()).toBe('test-pair');
  expect(window.location.hash).toBe('');
});

it('uses the authorization header for HTTP and never leaks the token into the request URL', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const client = new RemoteClient('https://desktop.example', 'secret');
  await client.state();
  expect(String(fetch.mock.calls[0][0])).toBe('https://desktop.example/api/state');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
});

it('reports a failed input request instead of treating the command as sent', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('session not found', { status: 404 })));
  const client = new RemoteClient('https://desktop.example', 'test');
  await expect(client.input('a/b', 'hello\r')).rejects.toMatchObject({ status: 404 });
});

it('distinguishes authentication expiry and stale file revisions', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('{}', { status: 409 }));
  vi.stubGlobal('fetch', fetch);
  const client = new RemoteClient('https://desktop.example', 'test');
  await expect(client.state()).rejects.toBeInstanceOf(RemoteError);
  await expect(client.save('one', 'src/a b.ts', 'new', { content: 'old', revision: 'v1', line_ending: 'crlf', has_utf8_bom: true, size: 3 })).rejects.toMatchObject({ status: 409 });
  expect(String(fetch.mock.calls[1][0])).toContain('path=src%2Fa%20b.ts');
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ expected_revision: 'v1', has_utf8_bom: true, line_ending: 'crlf' });
});
