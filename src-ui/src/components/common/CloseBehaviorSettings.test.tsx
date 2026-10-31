// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloseBehaviorSettings } from './CloseBehaviorSettings';
const native = vi.hoisted(() => ({ invoke: vi.fn(), mac: false }));
vi.mock('../../tauri', () => ({ invoke: native.invoke }));
vi.mock('../../lib/platform', () => ({ get IS_MACOS() { return native.mac; } }));
vi.mock('../../i18n/useT', async () => { const { en } = await import('../../i18n/en'); return { useT: () => (key: keyof typeof en) => en[key] }; });
const flush = () => act(async () => {});
const pending = () => { let resolve!: (v: unknown) => void; let reject!: (e: Error) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const preference = (enabled = false, available = true) => ({ closeToTray: enabled, trayAvailable: available });
beforeEach(() => { native.invoke.mockReset(); native.mac = false; });
afterEach(cleanup);
it('reads native preferences before allowing changes', async () => {
  const read = pending(); native.invoke.mockReturnValue(read.promise); render(<CloseBehaviorSettings />);
  expect((screen.getByRole('button', { name: 'Keep in system tray' }) as HTMLButtonElement).disabled).toBe(true);
  read.resolve(preference(true)); await flush();
  expect(screen.getByRole('button', { name: 'Keep in system tray' }).getAttribute('aria-pressed')).toBe('true');
});
it('waits for persistence and suppresses repeated saves', async () => {
  const write = pending(); native.invoke.mockResolvedValueOnce(preference()).mockReturnValueOnce(write.promise);
  render(<CloseBehaviorSettings />); await flush();
  const tray = screen.getByRole('button', { name: 'Keep in system tray' }); fireEvent.click(tray); fireEvent.click(tray);
  expect(native.invoke).toHaveBeenCalledTimes(2); expect(tray.getAttribute('aria-pressed')).toBe('false');
  write.resolve(preference(true)); await flush(); expect(tray.getAttribute('aria-pressed')).toBe('true');
});
it('keeps the previous choice when saving fails and allows retry', async () => {
  native.invoke.mockResolvedValueOnce(preference()).mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(preference(true));
  render(<CloseBehaviorSettings />); await flush(); fireEvent.click(screen.getByRole('button', { name: 'Keep in system tray' })); await flush();
  expect(screen.getByRole('alert')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Exit application' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Keep in system tray' })); await flush();
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('button', { name: 'Keep in system tray' }).getAttribute('aria-pressed')).toBe('true');
});
it('orders reopening Settings after an in-flight accepted save', async () => {
  const write = pending(); native.invoke.mockResolvedValueOnce(preference()).mockReturnValueOnce(write.promise).mockResolvedValueOnce(preference(true));
  const first = render(<CloseBehaviorSettings />); await flush(); fireEvent.click(screen.getByRole('button', { name: 'Keep in system tray' })); first.unmount();
  render(<CloseBehaviorSettings />); await flush(); expect(native.invoke).toHaveBeenCalledTimes(2);
  write.resolve(preference(true)); await flush(); expect(native.invoke).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('button', { name: 'Keep in system tray' }).getAttribute('aria-pressed')).toBe('true');
});
it('offers retry after a failed read and disables unavailable tray integration', async () => {
  native.invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(preference(false, false));
  render(<CloseBehaviorSettings />); await flush(); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flush();
  expect(screen.getByRole('status').textContent).toContain('unavailable');
  expect((screen.getByRole('button', { name: 'Keep in system tray' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Exit application' }) as HTMLButtonElement).disabled).toBe(false);
});
it('preserves the native Dock close option on macOS', async () => {
  native.mac = true; native.invoke.mockResolvedValue(preference()); render(<CloseBehaviorSettings />); await flush();
  expect(screen.getByRole('button', { name: 'Keep in Dock' })).toBeTruthy();
});
