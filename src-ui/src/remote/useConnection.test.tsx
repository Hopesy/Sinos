// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteClient, RemoteError } from './client';
import { useConnection } from './useConnection';

const client = new RemoteClient('http://localhost', 'test');
function Harness() { const { connection, state } = useConnection(client); return <span>{connection}:{state.sessions.length}</span>; }
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(client, 'tools').mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('shows a connected empty workspace without implying that a terminal is still connecting', async () => {
  vi.spyOn(client, 'state').mockResolvedValue({ sessions: [], device_name: 'desktop' });
  render(<Harness />); await act(async () => {});
  expect(screen.getByText('online:0')).toBeTruthy();
});

it('keeps a slow poll single-flight and recovers after an authentication error', async () => {
  let finish!: (value: { sessions: []; device_name: string }) => void;
  const state = vi.spyOn(client, 'state').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<Harness />);
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); window.dispatchEvent(new Event('online')); });
  expect(state).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ sessions: [], device_name: 'desktop' }); });
  state.mockRejectedValueOnce(new RemoteError(401, 'expired'));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText('unauthorized:0')).toBeTruthy();
  state.mockResolvedValue({ sessions: [], device_name: 'desktop' });
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(screen.getByText('online:0')).toBeTruthy();
});
