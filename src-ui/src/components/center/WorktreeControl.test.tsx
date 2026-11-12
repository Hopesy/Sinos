// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorktreeControl, WorktreeJanitor } from './WorktreeControl';
import type { TerminalSession } from '../../store/app-state';

const mocks = vi.hoisted(() => ({
  stateRef: { current: { terminals: [] as unknown[] } },
  dispatch: vi.fn(), create: vi.fn(), remove: vi.fn(), pending: vi.fn(),
}));
vi.mock('../../store/app-state', () => ({
  useAppState: () => ({ state: mocks.stateRef.current }),
  useAppStateRef: () => mocks.stateRef,
  useAppDispatch: () => mocks.dispatch,
}));
vi.mock('../../i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('../../lib/worktree-pending', () => ({ setWorktreePending: mocks.pending }));
vi.mock('../../lib/worktree', () => ({
  createWorktree: mocks.create, removeWorktree: mocks.remove,
  insideWorktrees: () => false, worktreeFromPath: () => null,
  worktreeAvailable: async () => true, sweepWorktrees: async () => {},
  worktreeStatus: async () => null, mergeWorktree: vi.fn(),
}));
beforeEach(() => { vi.clearAllMocks(); mocks.remove.mockResolvedValue(undefined); });
afterEach(cleanup);

it('uses the actual branch when the last worktree tab closes', async () => {
  const worktree = { root: '/project', path: '/project/.claude/worktrees/coffee-fix-123', branch: 'project/fix-123' };
  mocks.stateRef.current = { terminals: [{ id: 'one', worktree }] };
  const view = render(<WorktreeJanitor />);
  mocks.stateRef.current = { terminals: [] };
  view.rerender(<WorktreeJanitor />);
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(worktree));
});

it('uses the new lease when a worktree is reopened before cleanup', async () => {
  const old = { root: '/project', path: '/project/.claude/worktrees/coffee-fix-123', branch: 'project/fix-123', lease: 'old' };
  const reopened = { ...old, lease: 'new' };
  mocks.stateRef.current = { terminals: [{ id: 'one', worktree: old }] };
  const view = render(<WorktreeJanitor />);
  mocks.stateRef.current = { terminals: [{ id: 'two', worktree: reopened }] };
  view.rerender(<WorktreeJanitor />);
  expect(mocks.remove).not.toHaveBeenCalled();
  mocks.stateRef.current = { terminals: [] };
  view.rerender(<WorktreeJanitor />);
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(reopened));
});

it('retains the newest lease while an older tab remains open', async () => {
  const old = { root: '/project', path: '/project/.claude/worktrees/coffee-fix-123', branch: 'project/fix-123', lease: 'old' };
  const reopened = { ...old, lease: 'new' };
  mocks.stateRef.current = { terminals: [{ id: 'one', worktree: old }] };
  const view = render(<WorktreeJanitor />);
  mocks.stateRef.current = { terminals: [{ id: 'one', worktree: old }, { id: 'two', worktree: reopened }] };
  view.rerender(<WorktreeJanitor />);
  mocks.stateRef.current = { terminals: [{ id: 'one', worktree: old }] };
  view.rerender(<WorktreeJanitor />);
  mocks.stateRef.current = { terminals: [] };
  view.rerender(<WorktreeJanitor />);
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(reopened));
});

it('removes a late-created worktree when its session was closed during creation', async () => {
  const tab = { id: 'closed-tab', tool: 'claude', folderPath: '/project' } as TerminalSession;
  mocks.stateRef.current = { terminals: [tab] };
  let finish!: (value: unknown) => void;
  mocks.create.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<WorktreeControl tab={tab} started={false} running={false} />);
  const toggle = view.getByRole('checkbox');
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
  fireEvent.click(toggle);
  expect(mocks.create).toHaveBeenCalledOnce();
  mocks.stateRef.current = { terminals: [] };
  view.unmount();
  const worktree = { path: '/project/.coffee-worktrees/session', branch: 'coffee/session', root: '/project' };
  await act(async () => { finish({ cwd: worktree.path, worktree }); });
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(worktree);
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.pending).not.toHaveBeenCalledWith(expect.any(String), 'starting');
  expect(mocks.pending).toHaveBeenLastCalledWith(tab.id, null);
});

it('keeps a late-created worktree when switching composers leaves its original tab open', async () => {
  const tab = { id: 'open-tab', tool: 'claude', folderPath: '/project' } as TerminalSession;
  mocks.stateRef.current = { terminals: [tab] };
  let finish!: (value: unknown) => void;
  mocks.create.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<WorktreeControl tab={tab} started={false} running={false} />);
  const toggle = view.getByRole('checkbox');
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
  fireEvent.click(toggle);
  view.unmount();
  const worktree = { path: '/project/.coffee-worktrees/session', branch: 'coffee/session', root: '/project' };
  await act(async () => { finish({ cwd: worktree.path, worktree }); });
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: 'SET_TERMINAL_WORKTREE', id: tab.id, newId: expect.any(String),
    cwd: worktree.path, worktree, origin: '/project',
  });
  expect(mocks.pending).toHaveBeenCalledWith(expect.any(String), 'starting');
  expect(mocks.pending).toHaveBeenLastCalledWith(tab.id, null);
});
