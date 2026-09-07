// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useDirectory } from './use-directory';

const { listDirectory } = vi.hoisted(() => ({ listDirectory: vi.fn() }));
vi.mock('../tauri', () => ({ commands: { listDirectory } }));
vi.mock('../store/app-state', () => ({ normalizeProjectPath: (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() }));
const entry = { path: 'C:/project/child', name: 'child', is_dir: true, size: 0 };
const onError = vi.fn();
function Child() {
  const [open, setOpen] = useState(false);
  return <button onClick={() => setOpen(!open)}>{open ? 'expanded' : 'collapsed'}</button>;
}
function Harness({ path = 'C:/project' }: { path?: string }) {
  const { entries, error } = useDirectory(path, true, onError);
  return <>{entries ? entries.map(e => <Child key={e.path} />) : <span>{error ? 'error' : 'loading'}</span>}</>;
}
async function refresh(count = 1) {
  await act(async () => {
    for (let i = 0; i < count; i++) window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath: 'c:\\project\\' } }));
    await vi.advanceTimersByTimeAsync(250);
  });
}
beforeEach(() => { vi.useFakeTimers(); listDirectory.mockReset(); onError.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('preserves expanded descendants during a slow refresh and coalesces 1000 events', async () => {
  listDirectory.mockResolvedValueOnce([entry]);
  render(<Harness />);
  await act(async () => {});
  await act(async () => { screen.getByText('collapsed').click(); });
  const child = screen.getByText('expanded');
  let finish!: (entries: typeof entry[]) => void;
  listDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await refresh(1000);
  expect(listDirectory).toHaveBeenCalledTimes(2);
  expect(screen.getByText('expanded')).toBe(child);
  expect(screen.queryByText('loading')).toBeNull();
  await refresh(1000);
  expect(listDirectory).toHaveBeenCalledTimes(2);
  listDirectory.mockResolvedValue([entry]);
  await act(async () => { finish([entry]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(listDirectory).toHaveBeenCalledTimes(3);
  expect(screen.getByText('expanded')).toBe(child);
});

it('keeps the last successful tree on a transient error and recovers', async () => {
  listDirectory.mockResolvedValueOnce([entry]);
  render(<Harness />);
  await act(async () => {});
  await act(async () => { screen.getByText('collapsed').click(); });
  listDirectory.mockRejectedValueOnce(new Error('temporary failure'));
  await refresh();
  expect(screen.getByText('expanded')).toBeTruthy();
  expect(onError).toHaveBeenCalledTimes(1);
  listDirectory.mockResolvedValueOnce([entry]);
  await refresh();
  expect(screen.getByText('expanded')).toBeTruthy();
});

it('ignores an old workspace response after switching projects', async () => {
  let finish!: (entries: typeof entry[]) => void;
  listDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<Harness />);
  listDirectory.mockResolvedValueOnce([]);
  view.rerender(<Harness path="C:/other" />);
  await act(async () => {});
  await act(async () => { finish([entry]); });
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText('loading')).toBeNull();
});

it('continues refreshing under sustained writes without resetting child state', async () => {
  listDirectory.mockResolvedValue([entry]);
  render(<Harness />);
  await act(async () => {});
  await act(async () => { screen.getByText('collapsed').click(); });
  const child = screen.getByText('expanded');
  for (let i = 0; i < 120; i++) {
    await refresh(20);
    expect(screen.getByText('expanded')).toBe(child);
  }
  expect(listDirectory).toHaveBeenCalledTimes(121);
});
