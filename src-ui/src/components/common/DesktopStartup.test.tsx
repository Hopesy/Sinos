// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopStartup } from './DesktopStartup';

const native = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), close: vi.fn(async () => {}), minimize: vi.fn(async () => {}) }));
vi.mock('../../tauri', () => ({ isTauri: true, invoke: native.invoke, commands: { windowClose: native.close, windowMinimize: native.minimize } }));
vi.mock('../../lib/platform', () => ({ IS_MACOS: false }));
const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
const pending = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => act(async () => {});
const tick = () => act(async () => { const current = [...frames.values()]; frames.clear(); current.forEach(fn => fn(performance.now())); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function mount() {
  const ready = pending(), scale = pending();
  const view = render(<StrictMode><DesktopStartup ready={ready.promise} scaleReady={scale.promise}><button>Workspace content</button></DesktopStartup></StrictMode>);
  return { ready, scale, ...view };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); frames.clear(); localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('paints startup immediately, restores scale before reveal, and covers the workspace until its paint', async () => {
  const f = mount();
  expect(screen.getByRole('dialog').textContent).toContain('正在准备你的工作区');
  expect(screen.queryByText('Workspace content')).toBeNull(); expect(frames.size).toBe(0);
  f.scale.resolve(); await flush(); await tick(); expect(native.invoke).not.toHaveBeenCalled();
  await tick(); expect(native.invoke).toHaveBeenCalledExactlyOnceWith('show_main_window');
  f.ready.resolve(); await flush();
  expect(screen.getByText('Workspace content').closest('.desktop-workspace')?.hasAttribute('inert')).toBe(true);
  expect(screen.queryByRole('button', { name: /进入工作区/ })).toBeNull();
  await tick(); await tick(); expect(screen.getByRole('button', { name: /进入工作区/ })).toBeTruthy();
  await advance(950); await advance(280);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByRole('button', { name: 'Workspace content' })).toBeTruthy();
  expect(screen.getByText('Workspace content').closest('.desktop-workspace')?.hasAttribute('inert')).toBe(false);
  expect(native.invoke).toHaveBeenCalledTimes(1);
});
it('waits for window scale even if workspace dependencies resolve first', async () => {
  const f = mount(); f.ready.resolve(); await flush(); await advance(2000);
  expect(native.invoke).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: /进入工作区/ })).toBeNull();
  f.scale.resolve(); await flush(); await tick(); await tick(); await tick(); await tick();
  fireEvent.click(screen.getByRole('button', { name: /进入工作区/ })); await advance(280);
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('keeps slow startup truthful and exposes reload and native window controls', async () => {
  mount(); await advance(8000);
  expect(screen.getByRole('status').textContent).toContain('启动用时稍长');
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
  expect(screen.queryByText('Workspace content')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getByRole('button', { name: '最小化' }));
  expect(native.close).toHaveBeenCalledTimes(1); expect(native.minimize).toHaveBeenCalledTimes(1);
});
it('removes the ceremonial hold and fade when reduced motion is requested', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const f = mount(); f.ready.resolve(); f.scale.resolve(); await flush();
  await tick(); await tick(); await tick(); await tick(); await advance(0); await advance(0);
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('cancels pending frames and timers on unmount in StrictMode', async () => {
  const f = mount(); f.scale.resolve(); await flush(); await tick(); f.unmount();
  f.ready.resolve(); await flush(); await tick(); await advance(10_000);
  expect(native.invoke).not.toHaveBeenCalled(); expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it.each([['zh-CN', '让想法，从这里发生。'], ['zh-TW', '讓想法，從這裡發生。'], ['en', 'A place for your next idea.'], ['ja', '次のアイデアは、ここから。'], ['ko', '다음 아이디어가 시작되는 곳.'], ['fr', 'A place for your next idea.']])('uses saved %s startup copy', (language, text) => {
  localStorage.setItem('cc-lang', language); mount(); expect(screen.getByText(text)).toBeTruthy();
});
