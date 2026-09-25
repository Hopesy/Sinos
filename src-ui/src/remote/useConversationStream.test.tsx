// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationStream } from './useConversationStream';
import type { RemoteClient, RemoteSocket } from './client';
import { projectConversation, type ConversationProjection } from './conversationProjection';
import { trustMenu } from './fixtures/terminalMenus';

const decoder = vi.hoisted(() => ({ write: vi.fn(), dispose: vi.fn(), resize: vi.fn() }));
vi.mock('./TerminalConversation', () => ({ TerminalConversation: class { write = decoder.write; dispose = decoder.dispose; resize = decoder.resize; } }));
class Socket implements RemoteSocket {
  readyState = 0;
  onopen: RemoteSocket['onopen'] = null; onmessage: RemoteSocket['onmessage'] = null;
  onclose: RemoteSocket['onclose'] = null; onerror: RemoteSocket['onerror'] = null;
  send = vi.fn();
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  output(sequence?: number) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'output', data: 'screen', sequence }) })); }
  close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }
}
const question: ConversationProjection = { events: [], question: { id: 'question', text: 'Do you want to proceed?', choices: [{ label: 'Yes', input: '\r' }, { label: 'No', input: '\x1b[B\r' }] } };
const session = { id: 'same-session', tool: 'claude', cwd: '/workspace', running: true, paused: false, cols: 100, rows: 30, output_chunks: 1 };
let sockets: Socket[];
const socket = vi.fn(() => { const value = new Socket(); sockets.push(value); return value; });
const answer = vi.fn();
const client = { socket, answer } as unknown as RemoteClient;
beforeEach(() => { sockets = []; socket.mockClear(); answer.mockReset().mockResolvedValue(undefined); decoder.write.mockReset().mockResolvedValue(question); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('receives Codex events without waiting for VT decoding and invalidates authority on disconnect', async () => {
  const hook = renderHook(() => useConversationStream(client, { ...session, tool: 'codex' }, true));
  await waitFor(() => expect(sockets).toHaveLength(1));
  await act(async () => sockets[0].open());
  decoder.write.mockImplementation(() => new Promise(() => {}));
  act(() => {
    sockets[0].output(1);
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'codex', page: { epoch: 'e', cursor: 1, reset: true, online: true, complete: true, thread_id: 'root', events: [{ sequence: 1, message: { method: 'item/agentMessage/delta', params: { threadId: 'root', itemId: 'reply', delta: '- First\n- Second' } } }] } }) }));
  });
  expect(hook.result.current.codex.available).toBe(true);
  expect(hook.result.current.codex.messages[0].content).toBe('- First\n- Second');
  expect(hook.result.current.canAnswer).toBe(false);
  act(() => sockets[0].close());
  expect(hook.result.current.codex.available).toBe(false);
  expect(hook.result.current.codex.retained).toBe(true);
  expect(hook.result.current.codex.messages[0].content).toBe('- First\n- Second');
  expect(answer).not.toHaveBeenCalled();
});
async function mount() {
  const hook = renderHook(() => useConversationStream(client, session, true));
  await waitFor(() => expect(sockets).toHaveLength(1));
  await act(async () => { sockets[0].open(); sockets[0].output(42); });
  return hook;
}

it('keeps Claude Markdown during reconnect and leaves approval input on the guarded PTY path', async () => {
  const { result } = await mount();
  const frame = { type: 'claude', page: { epoch: 'claude', cursor: 3, reset: true, online: true, complete: true, has_more: false, thread_id: 'session', events: [
    { sequence: 1, message: { kind: 'session', session: 'session', model: 'Opus' } },
    { sequence: 2, message: { kind: 'start', turn: 'turn', text: 'hello' } },
    { sequence: 3, message: { kind: 'text', turn: 'turn', step: 0, index: 0, text: '- **First**\n- Second' } },
  ] } };
  act(() => sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })));
  expect(result.current.claude.available).toBe(true);
  expect(result.current.projection.question?.id).toBe('question');
  expect(answer).not.toHaveBeenCalled();
  act(() => sockets[0].close());
  expect(result.current.claude.retained).toBe(true);
  expect(result.current.claude.turns[0].messages[0].content).toContain('**First**');
  await expect(result.current.answer('question', 0)).rejects.toThrow('STALE_INTERACTION');
});

it('decodes output without forwarding terminal replies or resize events and answers only on a user action', async () => {
  const { result } = await mount();
  expect(answer).not.toHaveBeenCalled();
  expect(sockets[0].send).not.toHaveBeenCalled();
  expect(result.current.projection.question?.text).toBe(question.question?.text);
  await act(async () => { await result.current.answer('question', 1); });
  expect(answer).toHaveBeenCalledExactlyOnceWith('same-session', '\x1b[B\r', 42);
});

it('rejects a stale choice immediately when a newer screen is still being decoded', async () => {
  const { result } = await mount();
  let resolve!: (value: ConversationProjection) => void;
  decoder.write.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  act(() => sockets[0].output(43));
  expect(result.current.canAnswer).toBe(false);
  await expect(result.current.answer('question', 0)).rejects.toThrow('STALE_INTERACTION');
  expect(answer).not.toHaveBeenCalled();
  await act(async () => resolve({ events: [], question: null }));
  expect(result.current.projection.question).toBeNull();
});

it('renders intermediate frames during sustained output while keeping stale choices disabled', async () => {
  const { result } = await mount();
  const pending: ((value: ConversationProjection) => void)[] = [];
  decoder.write.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  act(() => { sockets[0].output(43); sockets[0].output(44); sockets[0].output(45); });
  const frame = (text: string): ConversationProjection => ({ ...question, events: [{ id: 'reply', kind: 'assistant', text }] });
  await act(async () => pending[0](frame('First')));
  expect(result.current.projection.events[0].text).toBe('First');
  expect(result.current.canAnswer).toBe(false);
  await act(async () => pending[2](frame('Final')));
  expect(result.current.canAnswer).toBe(true);
  await act(async () => pending[1](frame('Late callback')));
  expect(result.current.projection.events[0].text).toBe('Final');
  await act(async () => result.current.answer('question', 0));
  expect(answer).toHaveBeenCalledExactlyOnceWith(session.id, '\r', 45);
});

it('clears old questions on reset and rejects callbacks from the discarded decoder', async () => {
  const { result } = await mount();
  let finish!: (value: ConversationProjection) => void;
  decoder.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => {
    sockets[0].output(43);
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset' }) }));
  });
  expect(result.current.projection.question).toBeNull();
  await act(async () => finish(question));
  expect(result.current.projection.question).toBeNull();
  expect(result.current.canAnswer).toBe(false);
});

it('maps phone menu taps to the current desktop cursor and rejects choices from an earlier cursor position', async () => {
  const first = projectConversation(trustMenu());
  decoder.write.mockResolvedValue(first);
  const { result } = await mount();
  expect(answer).not.toHaveBeenCalled();
  await act(async () => result.current.answer(first.question!.id, 1));
  expect(answer).toHaveBeenCalledExactlyOnceWith(session.id, '\x1b[B\r', 42);
  const moved = projectConversation(trustMenu(1));
  decoder.write.mockResolvedValue(moved);
  await act(async () => sockets[0].output(43));
  await expect(result.current.answer(first.question!.id, 0)).rejects.toThrow('STALE_INTERACTION');
  expect(answer).toHaveBeenCalledTimes(1);
  await act(async () => result.current.answer(moved.question!.id, 0));
  expect(answer).toHaveBeenLastCalledWith(session.id, '\x1b[A\r', 43);
});

it('does not submit the same answered question twice', async () => {
  const { result } = await mount();
  await act(async () => { await result.current.answer('question', 0); });
  await expect(result.current.answer('question', 1)).rejects.toThrow('STALE_INTERACTION');
  expect(answer).toHaveBeenCalledTimes(1);
});

it('identifies older hosts without answer support instead of offering unusable choices', async () => {
  const { result } = await mount();
  await act(async () => sockets[0].output());
  expect(result.current.answerUnsupported).toBe(true);
  expect(result.current.canAnswer).toBe(false);
  await expect(result.current.answer('question', 0)).rejects.toThrow('STALE_INTERACTION');
  expect(answer).not.toHaveBeenCalled();
});

it('reconnects without replaying a user choice and blocks choices while disconnected', async () => {
  const { result } = await mount();
  vi.useFakeTimers();
  act(() => sockets[0].close());
  await expect(result.current.answer('question', 0)).rejects.toThrow('STALE_INTERACTION');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(sockets).toHaveLength(2);
  await act(async () => { sockets[1].open(); sockets[1].output(43); });
  expect(result.current.stream).toBe('live');
  expect(answer).not.toHaveBeenCalled();
});

it('sends multi-select deltas and text responses only to the matching current screen', async () => {
  decoder.write.mockResolvedValue({ events: [], question: { id: 'multi', kind: 'multi', text: 'Choose', cursor: 0, choices: [{ label: 'A', input: '', checked: true }, { label: 'B', input: '' }] } });
  const { result } = await mount();
  await act(async () => { await result.current.answer('multi', [1]); });
  expect(answer).toHaveBeenLastCalledWith(session.id, ' \x1b[B \r', 42);
  decoder.write.mockResolvedValue({ events: [], question: { id: 'text', kind: 'text', text: 'Describe', choices: [] } });
  await act(async () => sockets[0].output(43));
  await expect(result.current.answer('multi', [0])).rejects.toThrow('STALE_INTERACTION');
  await act(async () => { await result.current.answer('text', '第一行\n第二行'); });
  expect(answer).toHaveBeenLastCalledWith(session.id, '第一行\n第二行', 43, 'text');
});
