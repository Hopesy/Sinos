// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopNotificationSettings } from './DesktopNotificationSettings';
const native = vi.hoisted(() => ({ invoke: vi.fn(), clear: vi.fn() }));
vi.mock('../../tauri', () => ({ invoke: native.invoke }));
vi.mock('../../store/app-state', () => ({ useAppLanguage: () => 'zh-CN' }));
vi.mock('../../lib/platform', () => ({ IS_WINDOWS: true }));
vi.mock('../../lib/session-replies', () => ({ clearUnreadTasks: native.clear }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); native.invoke.mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('persists independent notification preferences and can clear the badge count', () => {
  render(<DesktopNotificationSettings />);
  const done = screen.getByRole('switch', { name: '任务完成时弹出通知' }) as HTMLInputElement;
  fireEvent.click(done);
  expect(localStorage.getItem('sinos-notify-done')).toBe('false');
  expect(done.checked).toBe(false);
  expect((screen.getByRole('switch', { name: '需要回答或授权时弹出通知' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '清除完成计数' })); expect(native.clear).toHaveBeenCalledTimes(1);
});
it('reports native notification settings without changing completion counts', async () => {
  native.invoke.mockResolvedValueOnce(false);
  render(<DesktopNotificationSettings />);
  fireEvent.click(screen.getByRole('button', { name: '测试 Windows 通知' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Windows 通知设置'));
  expect(native.invoke).toHaveBeenCalledWith('show_desktop_notification', { sessionId: '', title: 'Sinos CLI', body: 'Sinos CLI 通知已准备就绪' });
  expect(native.clear).not.toHaveBeenCalled();
});
it('preserves the selected preference if storage rejects a save', () => {
  render(<DesktopNotificationSettings />);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  const done = screen.getByRole('switch', { name: '任务完成时弹出通知' }) as HTMLInputElement;
  fireEvent.click(done);
  expect(done.checked).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('操作失败');
});
