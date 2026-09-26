// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShareEntry } from './ShareEntry';
import { claimShare, forgetShare, savedShare } from './shareClient';
import type { Connection, RemoteState } from '../types';

const live = vi.hoisted(() => ({ state: { sessions: [], device_name: '' } as RemoteState, connection: 'online' as Connection, dispose: vi.fn(), resumeHere: vi.fn(), refresh: vi.fn() }));
vi.mock('./shareClient', () => ({ claimShare: vi.fn(), forgetShare: vi.fn(), savedShare: vi.fn(), shareError: () => 'Cannot claim' }));
vi.mock('../pair/RelayClient', () => ({ RelayClient: class { dispose = live.dispose; resumeHere = live.resumeHere; } }));
vi.mock('../useConnection', () => ({ useConnection: () => ({ state: live.state, connection: live.connection, refresh: live.refresh }) }));
vi.mock('../useMobileViewport', () => ({ useMobileViewport: () => {} }));
vi.mock('../usePhoneAppearance', () => ({ usePhoneAppearance: () => ({ theme: 'light', style: {} }) }));
vi.mock('../ChatView', () => ({ ChatView: ({ readOnly, ephemeralDrafts }: { readOnly: boolean; ephemeralDrafts: boolean }) => <div data-testid="guest-chat">{readOnly ? 'View' : 'Control'} {ephemeralDrafts ? 'Ephemeral' : 'Persistent'}</div> }));
const id = 'a'.repeat(43);
const device = { pairId: 'p'.repeat(22), token: 't'.repeat(32), contentKey: 'k', name: 'guest', relay: 'https://relay.test' };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(savedShare).mockReturnValue(null); vi.mocked(claimShare).mockResolvedValue(device);
  live.connection = 'online';
  live.state = { device_name: 'Shared', sessions: [{ id: 'session', cwd: '/project', tool: 'claude', running: true, paused: false, cols: 80, rows: 24, output_chunks: 0 }], share: { mode: 'view', expiresAt: Date.now() + 60000 } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('never consumes previews, then enforces the authenticated permission and clears access on expiry', async () => {
  const view = render(<ShareEntry id={id} />);
  await act(async () => {});
  expect(claimShare).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '领取访问并打开' })); });
  expect(claimShare).toHaveBeenCalledExactlyOnceWith(id);
  expect(screen.getByTestId('guest-chat').textContent).toBe('View Ephemeral');
  live.state = { ...live.state, share: { ...live.state.share!, mode: 'control' } };
  view.rerender(<ShareEntry id={id} />);
  expect(screen.getByTestId('guest-chat').textContent).toBe('Control Ephemeral');
  await act(async () => { await vi.advanceTimersByTimeAsync(60001); });
  expect(screen.queryByTestId('guest-chat')).toBeNull();
  expect(live.dispose).toHaveBeenCalled(); expect(forgetShare).toHaveBeenCalledWith(id);
});

it('resumes the same tab without claiming again and drops revoked access', async () => {
  vi.mocked(savedShare).mockReturnValue(device);
  const view = render(<ShareEntry id={id} />);
  await act(async () => {});
  expect(claimShare).not.toHaveBeenCalled(); expect(screen.getByTestId('guest-chat')).toBeTruthy();
  live.connection = 'unauthorized'; view.rerender(<ShareEntry id={id} />);
  expect(screen.queryByTestId('guest-chat')).toBeNull();
  expect(forgetShare).toHaveBeenCalledWith(id);
});

it('never renders a full desktop response that lacks a scoped grant', async () => {
  vi.mocked(savedShare).mockReturnValue(device);
  live.state = { ...live.state, share: undefined };
  render(<ShareEntry id={id} />); await act(async () => {});
  expect(screen.queryByTestId('guest-chat')).toBeNull(); expect(live.dispose).toHaveBeenCalled();
});
