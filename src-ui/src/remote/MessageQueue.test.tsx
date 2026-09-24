// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageQueue } from './MessageQueue';
import { ConversationQuestion } from './ConversationQuestion';
import { useMessageQueue } from './useMessageQueue';
import { renderHook } from '@testing-library/react';
import type { RemoteClient } from './client';

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });
it('holds a queued message before editing and leaves the editor open after a conflict', async () => {
  const action = vi.fn().mockResolvedValue(undefined);
  render(<MessageQueue messages={[{ id: 'one', text: '修改布局', revision: 1, status: 'queued' }]} disabled={false} canSend={false} held={false} onAction={action} />);
  fireEvent.click(screen.getByText('待发送 · 1'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '编辑消息：修改布局' })));
  expect(action).toHaveBeenCalledWith('hold', expect.objectContaining({ id: 'one' }));
  action.mockRejectedValue(new Error('QUEUE_CONFLICT'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新的布局' } });
  await act(async () => fireEvent.click(screen.getByText('保存')));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('新的布局');
});

it('does not send uncertain messages and reuses an enqueue ID after a timeout', async () => {
  vi.useFakeTimers();
  const snapshot = { messages: [], activity: { state: 'working', source: 'native_title', revision: 1, auto_send_ready: false } };
  const client = { queue: vi.fn().mockResolvedValue(snapshot), queueAction: vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(snapshot) } as unknown as RemoteClient;
  const hook = renderHook(() => useMessageQueue(client, 'session', true, true));
  await act(async () => {});
  await act(async () => { await expect(hook.result.current.add('下一步')).rejects.toThrow('timeout'); });
  hook.unmount();
  const restored = renderHook(() => useMessageQueue(client, 'session', true, true));
  await act(async () => { await restored.result.current.add('下一步'); });
  const calls = vi.mocked(client.queueAction).mock.calls;
  expect(calls[0][2]).toBe(calls[1][2]);
  cleanup();
  render(<MessageQueue messages={[{ id: 'one', text: '下一步', revision: 2, status: 'uncertain' }]} disabled={false} canSend held onAction={vi.fn()} />);
  fireEvent.click(screen.getByText('待发送 · 1'));
  expect((screen.getByText('现在发送') as HTMLButtonElement).disabled).toBe(true);
});

it('submits multi-selection only on confirm and preserves a text answer after failure', async () => {
  const onAnswer = vi.fn().mockRejectedValue(new Error('offline'));
  const base = { disabled: false, unsupported: false, answering: false, answered: false, disconnected: false, onAnswer };
  const view = render(<ConversationQuestion {...base} question={{ id: 'multi', kind: 'multi', text: '选择范围', choices: [{ label: '界面', input: '', checked: true }, { label: '测试', input: '' }] }} />);
  fireEvent.click(screen.getByLabelText('测试')); expect(onAnswer).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByText('确认选择 · 2 项')));
  expect(onAnswer).toHaveBeenCalledWith([0, 1]);
  view.unmount();
  render(<ConversationQuestion {...base} question={{ id: 'text', kind: 'text', text: '怎么调整？', choices: [] }} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '使用浅色\n增加留白' } });
  await act(async () => fireEvent.click(screen.getByText('回复')));
  expect(onAnswer).toHaveBeenLastCalledWith('使用浅色\n增加留白');
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('使用浅色\n增加留白');
});
