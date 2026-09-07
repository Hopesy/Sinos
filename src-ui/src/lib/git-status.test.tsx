// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitStatusProvider, useGitPollingGate } from './git-status';

const mock = vi.hoisted(() => ({
  gitChanges: vi.fn(),
  gitCaptureBaseline: vi.fn(async () => {}),
  state: { activeTerminalId: 'a', terminals: [{ id: 'a', sessionId: 'a', folderPath: 'C:/a', tool: 'claude' }], gitTrackingDisabledPaths: [] as string[] },
}));
vi.mock('../tauri', () => ({ commands: mock }));
vi.mock('../store/app-state', () => ({
  useAppState: () => ({ state: mock.state }),
  normalizeProjectPath: (p: string) => p.toLowerCase(),
  resolveDiffContext: (session: unknown) => session,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
function Gate() { useGitPollingGate(); return null; }
const tree = () => <GitStatusProvider><Gate /></GitStatusProvider>;
beforeEach(() => {
  vi.useFakeTimers();
  mock.gitChanges.mockReset();
  mock.state.gitTrackingDisabledPaths = [];
  mock.state.activeTerminalId = 'a';
  mock.state.terminals = [{ id: 'a', sessionId: 'a', folderPath: 'C:/a', tool: 'claude' }];
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.useRealTimers(); });

it('serializes slow scans across project switches and skips obsolete queued scans', async () => {
  let finish!: (result: { state: string }) => void;
  mock.gitChanges.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(tree());
  await act(async () => {});
  expect(mock.gitChanges).toHaveBeenCalledTimes(1);
  for (const id of ['b', 'c']) {
    mock.state.activeTerminalId = id;
    mock.state.terminals = [{ id, sessionId: id, folderPath: `C:/${id}`, tool: 'claude' }];
    view.rerender(tree());
    await act(async () => {});
  }
  expect(mock.gitChanges).toHaveBeenCalledTimes(1);
  mock.gitChanges.mockResolvedValue({ state: 'not_repo' });
  await act(async () => { finish({ state: 'not_repo' }); });
  expect(mock.gitChanges.mock.calls.map(args => args[0])).toEqual(['C:/a', 'C:/c']);
});

it('coalesces event storms, enforces rest time and ignores other repositories', async () => {
  mock.gitChanges.mockResolvedValue({ state: 'not_repo' });
  render(tree());
  await act(async () => {});
  await act(async () => {
    window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath: 'C:/other' } }));
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(mock.gitChanges).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (let i = 0; i < 1000; i++) window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath: 'C:/a' } }));
    await vi.advanceTimersByTimeAsync(1999);
  });
  expect(mock.gitChanges).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mock.gitChanges).toHaveBeenCalledTimes(2);
});

it('does not poll when tracking is disabled', async () => {
  mock.state.gitTrackingDisabledPaths = ['c:/a'];
  render(tree());
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mock.gitChanges).not.toHaveBeenCalled();
});
