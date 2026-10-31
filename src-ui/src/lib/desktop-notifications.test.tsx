// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), dispatch: vi.fn(), sound: vi.fn(), click: undefined as undefined | ((event: { payload: string }) => Promise<void>), stop: vi.fn(), state: { current: { currentLang: 'zh-CN', terminals: [{ id: 'a', tool: 'codex', codexMode: 'conversation', folderPath: 'C:/Project', resumeToken: 'a-token' }, { id: 'b', tool: 'claude', folderPath: 'C:/Other', resumeToken: 'b-token' }] } } }));
vi.mock('../tauri', () => ({ invoke: native.invoke, isTauri: true }));
vi.mock('../store/app-state', () => ({ useAppDispatch: () => native.dispatch, useAppStateRef: () => native.state }));
vi.mock('./notify-sound', () => ({ playNotifySound: native.sound }));
vi.mock('./agent-client', () => ({ openAgentConversation: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name, fn) => { native.click = fn; return native.stop; }) }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear(); native.invoke.mockReset(); native.invoke.mockResolvedValue(true);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

it('counts background completions, alerts questions, routes clicks and clears only viewed work', async () => {
  const notices = await import('./desktop-notifications'), replies = await import('./session-replies');
  const prefs = await import('./notification-preferences');
  renderHook(notices.useDesktopNotifications); await flush();
  // The production reader accepts richer terminal records; these fields are sufficient here.
  replies.updateSessionReplyReaders(native.state.current.terminals as Parameters<typeof replies.updateSessionReplyReaders>[0], ['a']);
  replies.recordSessionReply('a', 'codex', 'a-token'); await flush();
  expect(replies.getUnreadTaskCount()).toBe(0);
  expect(native.invoke.mock.calls.filter(([name]) => name === 'show_desktop_notification')).toHaveLength(0);
  replies.recordSessionReply('b', 'claude', 'b-token'); await flush();
  expect(replies.getUnreadTaskCount()).toBe(1);
  expect(native.invoke).toHaveBeenCalledWith('set_task_badge', { count: 1 });
  expect(native.invoke).toHaveBeenCalledWith('show_desktop_notification', expect.objectContaining({ sessionId: 'b', title: 'Sinos CLI · 任务完成' }));
  replies.recordSessionQuestion('b', 'claude'); await flush();
  expect(replies.getUnreadTaskCount()).toBe(1);
  expect(native.invoke).toHaveBeenCalledWith('show_desktop_notification', expect.objectContaining({ title: 'Sinos CLI · 需要你的回答' }));
  await native.click?.({ payload: 'b' });
  expect(native.dispatch).toHaveBeenCalledWith({ type: 'SET_ACTIVE_TERMINAL', id: 'b' });
  native.dispatch.mockClear(); await native.click?.({ payload: 'closed' }); expect(native.dispatch).not.toHaveBeenCalled();
  prefs.setNotificationPreference('done', false);
  replies.recordSessionReply('b', 'claude', 'b-token'); await flush();
  expect(replies.getUnreadTaskCount()).toBe(2);
  expect(native.invoke.mock.calls.filter(([name]) => name === 'show_desktop_notification')).toHaveLength(2);
  prefs.setNotificationPreference('badge', false); await flush();
  expect(native.invoke.mock.calls.filter(([name]) => name === 'set_task_badge').at(-1)).toEqual(['set_task_badge', { count: 0 }]);
  expect(replies.getUnreadTaskCount()).toBe(2);
  prefs.setNotificationPreference('badge', true); await flush();
  replies.updateSessionReplyReaders(native.state.current.terminals as Parameters<typeof replies.updateSessionReplyReaders>[0], ['b']); await flush();
  expect(replies.getUnreadTaskCount()).toBe(0);
  expect(native.invoke.mock.calls.filter(([name]) => name === 'set_task_badge').at(-1)).toEqual(['set_task_badge', { count: 0 }]);
});

it('coalesces badge changes behind a pending native call and applies the newest count last', async () => {
  let resolve!: () => void;
  native.invoke.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const { updateTaskBadge } = await import('./desktop-notifications');
  updateTaskBadge(1); updateTaskBadge(2); updateTaskBadge(3);
  expect(native.invoke).toHaveBeenCalledTimes(1);
  resolve(); await flush();
  expect(native.invoke.mock.calls).toEqual([['set_task_badge', { count: 1 }], ['set_task_badge', { count: 3 }]]);
});

it('removes subscriptions on unmount and lets silent notifications operate independently', async () => {
  localStorage.setItem('cc-sound-done', 'false');
  const { useDesktopNotifications } = await import('./desktop-notifications'), replies = await import('./session-replies');
  const view = renderHook(useDesktopNotifications); await flush();
  replies.recordSessionReply('b', 'claude', 'b-token'); await flush();
  expect(native.sound).not.toHaveBeenCalled();
  expect(native.invoke).toHaveBeenCalledWith('show_desktop_notification', expect.anything());
  view.unmount(); await flush(); native.invoke.mockClear();
  replies.recordSessionQuestion('b', 'claude'); await flush();
  expect(native.invoke).not.toHaveBeenCalled(); expect(native.stop).toHaveBeenCalledTimes(1);
});
