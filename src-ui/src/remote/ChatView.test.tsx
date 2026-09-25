// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';
import { RemoteClient, type ChatRead } from './client';
import { projectConversation, type ConversationProjection } from './conversationProjection';
import { trustMenu } from './fixtures/terminalMenus';
import { CodexEventStream, type CodexLive } from './CodexEventStream';
import { ClaudeEventStream, type ClaudeLive } from './ClaudeEventStream';

const live = vi.hoisted(() => ({ projection: { events: [], question: null } as ConversationProjection, codex: { available: false, messages: [] } as CodexLive, claude: { available: false, turns: [] } as ClaudeLive, stream: 'live', answer: vi.fn(), answering: false, answered: null }));
vi.mock('./useConversationStream', () => ({ useConversationStream: () => live }));
const client = { chat: vi.fn(), prompt: vi.fn(), input: vi.fn(), queue: vi.fn(), queueAction: vi.fn() } as unknown as RemoteClient;
const session = { id: 'chat-test', tool: 'claude', cwd: '/project', running: true, paused: false, cols: 80, rows: 24, output_chunks: 0 };
function read(data = '', revision = '1'): ChatRead { return { bound: true, data, revision, sourceId: 'native-one', cursor: data.length, history_cursor: 0, has_older: false, append: false, prepend: false, unchanged: false }; }
function mount() { return render(<ChatView client={client} session={session} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} />); }
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); live.codex = { available: false, messages: [] }; live.claude = { available: false, turns: [] }; live.projection = { events: [], question: null }; live.answer.mockReset().mockResolvedValue(undefined); vi.mocked(client.chat).mockReset().mockResolvedValue(read()); vi.mocked(client.prompt).mockReset().mockResolvedValue(undefined); vi.mocked(client.input).mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('renders Claude original Markdown once during streaming and native handoff while retaining approval controls', async () => {
  live.claude = new ClaudeEventStream().apply({ epoch: 'c', cursor: 3, reset: true, online: true, complete: true, has_more: false, thread_id: 'claude-session', events: [
    { sequence: 1, message: { kind: 'session', session: 'claude-session', model: 'Opus', percent: 18 } },
    { sequence: 2, message: { kind: 'start', turn: 'turn', text: 'hello' } },
    { sequence: 3, message: { kind: 'text', turn: 'turn', step: 0, index: 0, text: '1. **First**\n2. Second' } },
  ] });
  live.projection = { events: [{ id: 'vt', kind: 'assistant', text: 'unformatted echo' }], question: { id: 'approval', text: 'Allow tool?', choices: [{ label: 'Yes', input: '\r' }] } };
  const view = mount(); await act(async () => {});
  const article = view.container.querySelector('article.assistant');
  expect(article?.querySelectorAll('li')).toHaveLength(2);
  expect(screen.queryByText('unformatted echo')).toBeNull();
  expect(screen.getByLabelText('会话状态').textContent).toContain('Opus');
  expect(screen.getByLabelText('会话状态').textContent).toContain('18%');
  expect(screen.getByText('Allow tool?')).toBeTruthy(); expect(live.answer).not.toHaveBeenCalled();
  const data = [
    { uuid: 'native-user', message: { role: 'user', content: 'hello' } },
    { uuid: 'native-assistant', message: { role: 'assistant', content: '1. **First**\n2. Second' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  vi.mocked(client.chat).mockResolvedValue({ ...read(data), sourceId: 'claude_native_claude-session' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(view.container.querySelectorAll('article.assistant')).toHaveLength(1);
  expect(view.container.querySelector('article.assistant')).toBe(article);
});
it('renders structured deltas immediately, suppresses the terminal echo, and keeps approvals/footer intact', async () => {
  const events = new CodexEventStream();
  const delta = (sequence: number, method: string, params: Record<string, unknown>) => ({ sequence, message: { method, params: { threadId: 'root', ...params } } });
  live.codex = events.apply({ epoch: 'epoch', cursor: 3, reset: true, online: true, complete: true, thread_id: 'root', events: [
    delta(1, 'sinos/thread', { model: 'gpt-live', effort: 'high', cwd: '/project' }),
    delta(2, 'turn/started', { turn: { id: 'turn', status: 'inProgress' } }),
    delta(3, 'item/agentMessage/delta', { itemId: 'reply', delta: '**Live**\n\n- One\n- Two' }),
  ] });
  live.projection = { events: [{ id: 'vt', kind: 'assistant', text: 'Unformatted terminal echo' }], question: { id: 'approval', text: 'Allow command?', choices: [{ label: 'Yes', input: '\r' }] } };
  const props = { client, session: { ...session, tool: 'codex' }, online: true, toolName: 'Codex', onTitle: vi.fn(), insert: '', onInserted: vi.fn() };
  const view = render(<ChatView {...props} />); await act(async () => {});
  const article = view.container.querySelector('article');
  expect(article?.querySelectorAll('li')).toHaveLength(2);
  expect(screen.queryByText('Unformatted terminal echo')).toBeNull();
  expect(screen.getByLabelText('会话状态').textContent).toContain('gpt-live high');
  expect(screen.getByText('Allow command?')).toBeTruthy();
  expect(live.answer).not.toHaveBeenCalled();
  live.codex = events.apply({ epoch: 'epoch', cursor: 4, reset: false, online: true, complete: true, thread_id: 'root', events: [delta(4, 'item/agentMessage/delta', { itemId: 'reply', delta: '\n- Three' })] });
  view.rerender(<ChatView {...props} />);
  expect(view.container.querySelector('article')).toBe(article);
  expect(article?.querySelectorAll('li')).toHaveLength(3);
  vi.mocked(client.chat).mockResolvedValue({ ...read(JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { id: 'reply', type: 'AgentMessage', content: [{ type: 'Text', text: '**Live**\n\n- One\n- Two\n- Three' }] } } }) + '\n'), sourceId: 'codex_native_root' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(view.container.querySelectorAll('article')).toHaveLength(1);
  expect(view.container.querySelector('article')).toBe(article);
});
it('keeps the Codex footer outside history and shows native model/context even with an active question', async () => {
  const data = [
    { type: 'turn_context', payload: { model: 'gpt-5.4', effort: 'xhigh', cwd: '/new-project' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 112000, last_token_usage: { total_tokens: 32000 } } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  vi.mocked(client.chat).mockResolvedValue(read(data));
  const props = { client, session: { ...session, tool: 'codex' }, online: true, toolName: 'Codex', onTitle: vi.fn(), insert: '', onInserted: vi.fn() };
  const view = render(<ChatView {...props} />); await act(async () => {});
  const status = screen.getByLabelText('会话状态');
  expect(status.textContent).toContain('gpt-5.4 xhigh');
  expect(status.textContent).toContain('上下文剩余 80%');
  expect(status.textContent).toContain('/new-project');
  expect(status.closest('.chat-scroll')).toBeNull();
  live.projection = { events: [], question: { id: 'q', text: 'Continue?', choices: [{ label: 'Yes', input: '\r' }] } };
  view.rerender(<ChatView {...props} />);
  expect(screen.getByLabelText('会话状态')).toBe(status);
});

it('keeps the same message element when Codex native Markdown replaces the live projection', async () => {
  live.projection = projectConversation(['• **Changes**', '', '  • First', '  • Second'], 3, 'codex');
  const view = render(<ChatView client={client} session={{ ...session, tool: 'codex' }} online toolName="Codex" onTitle={vi.fn()} insert="" onInserted={vi.fn()} />);
  await act(async () => {});
  const article = view.container.querySelector('article');
  vi.mocked(client.chat).mockResolvedValue(read(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '**Changes**\n\n- First\n- Second' }] } }) + '\n', '2'));
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(view.container.querySelectorAll('article')).toHaveLength(1);
  expect(view.container.querySelector('article')).toBe(article);
});
it('sends one multiline prompt and removes its optimistic copy when native history arrives', async () => {
  mount(); await act(async () => {});
  const text = '第一行\n第二行';
  fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: text } });
  vi.mocked(client.chat).mockResolvedValue(read(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n', '2'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^发送$/ })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(client.prompt).toHaveBeenCalledExactlyOnceWith('chat-test', text);
  expect(screen.queryByText('已发送')).toBeNull();
  expect((screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement).value).toBe('');
  expect(screen.getAllByRole('article')).toHaveLength(1);
});
it('retains the draft when submission loses its connection and never automatically resends', async () => {
  vi.mocked(client.prompt).mockRejectedValue(new Error('disconnected'));
  mount(); await act(async () => {});
  fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '保留这条需求' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^发送$/ })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(client.prompt).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement).value).toBe('保留这条需求');
  expect(localStorage.getItem('sinos-mobile-chat-draft-chat-test')).toBe('保留这条需求');
  expect(screen.getByRole('alert').textContent).toContain('草稿已保留');
});

it('keeps the older-history cursor after live append and unchanged polls', async () => {
  vi.mocked(client.chat).mockResolvedValueOnce({ ...read(), history_cursor: 123, has_older: true })
    .mockResolvedValue({ ...read('', '2'), append: true, history_cursor: null, has_older: false });
  mount(); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(screen.getByRole('button', { name: '查看更早的消息' })).toBeTruthy();
  vi.mocked(client.chat).mockResolvedValue({ ...read(), prepend: true, history_cursor: 0, has_older: false });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '查看更早的消息' })); });
  expect(client.chat).toHaveBeenLastCalledWith('chat-test', null, undefined, 123);
  expect(screen.queryByRole('button', { name: '查看更早的消息' })).toBeNull();
});

it('starts a newly bound transcript from its own snapshot', async () => {
  vi.mocked(client.chat).mockResolvedValueOnce(read())
    .mockResolvedValueOnce({ ...read('partial', '2'), sourceId: 'native-two', append: true })
    .mockResolvedValue({ ...read(JSON.stringify({ type: 'user', message: { role: 'user', content: '新的完整会话' } }) + '\n', '2'), sourceId: 'native-two' });
  mount(); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(client.chat).toHaveBeenLastCalledWith('chat-test');
  expect(screen.getByText('新的完整会话')).toBeTruthy();
});

it('renders converted output directly as chat without a terminal surface', async () => {
  live.projection.events = [{ id: 'reply', kind: 'assistant', text: '已完成布局调整。' }];
  const { container } = mount(); await act(async () => {});
  expect(screen.getByText('已完成布局调整。')).toBeTruthy();
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(container.querySelector('.xterm, .mobile-terminal, canvas')).toBeNull();
  expect(screen.queryByText('桌面实况')).toBeNull();
});

it('converts a CLI question into explicit choices before native history is bound', async () => {
  vi.mocked(client.chat).mockResolvedValue({ ...read(), bound: false });
  live.projection.question = { id: 'approval', text: '是否允许读取 src/App.tsx？', choices: [{ label: '允许这次', input: '\r' }, { label: '拒绝', input: '\x1b[B\r' }] };
  mount(); await act(async () => {});
  expect(screen.getByText('是否允许读取 src/App.tsx？')).toBeTruthy();
  expect(live.answer).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '拒绝' })); });
  expect(live.answer).toHaveBeenCalledExactlyOnceWith('approval', 1);
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '打开终端' })).toBeNull();
});

it('replaces live message echoes with the authoritative desktop record', async () => {
  live.projection.events = [{ id: 'reply', kind: 'assistant', text: '已完成布局调整。' }];
  vi.mocked(client.chat).mockResolvedValue(read(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '已完成布局调整。' } }) + '\n'));
  mount(); await act(async () => {});
  expect(screen.getAllByText('已完成布局调整。')).toHaveLength(1);
});

it('preserves both former drafts in the shared composer', async () => {
  localStorage.setItem('sinos-mobile-chat-draft-chat-test', '对话草稿');
  localStorage.setItem('sinos-mobile-draft-chat-test', '终端草稿');
  const view = mount(); await act(async () => {});
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('对话草稿\n终端草稿');
  view.unmount(); mount(); await act(async () => {});
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('对话草稿\n终端草稿');
});

it('keeps Enter and IME local and preserves text written during an earlier submission', async () => {
  let finish!: () => void;
  vi.mocked(client.prompt).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mount(); await act(async () => {});
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '第一行\n第二行' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
  expect(client.prompt).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  fireEvent.change(input, { target: { value: '下一条消息' } });
  await act(async () => finish());
  expect(client.prompt).toHaveBeenCalledExactlyOnceWith(session.id, '第一行\n第二行');
  expect((input as HTMLTextAreaElement).value).toBe('下一条消息');
});

it('keeps repeated pending messages until distinct new desktop records acknowledge them', async () => {
  const user = (id: string) => JSON.stringify({ uuid: id, type: 'user', message: { role: 'user', content: '继续' } }) + '\n';
  vi.mocked(client.chat).mockResolvedValue(read(user('old')));
  mount(); await act(async () => {});
  for (let i = 0; i < 2; i++) {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '继续' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^发送$/ })); });
  }
  expect(screen.getAllByText('已发送')).toHaveLength(2);
  vi.mocked(client.chat).mockResolvedValue(read(user('old') + user('first'), '2'));
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(screen.getAllByText('已发送')).toHaveLength(1);
  vi.mocked(client.chat).mockResolvedValue(read(user('old') + user('first') + user('second'), '3'));
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(screen.queryByText('已发送')).toBeNull();
});

it('stops the same desktop session from the shared composer', async () => {
  mount(); await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止当前生成' })); });
  expect(client.input).toHaveBeenCalledExactlyOnceWith(session.id, '\x03');
  expect(client.prompt).not.toHaveBeenCalled();
});

it('renders startup trust choices with the selected item and sends only an explicit tap', async () => {
  vi.mocked(client.chat).mockResolvedValue({ ...read(), bound: false });
  live.projection = projectConversation(trustMenu());
  const { container } = mount(); await act(async () => {});
  expect(screen.getByText('C:\\Users\\zhouh')).toBeTruthy();
  expect(screen.getByText("Claude Code'll be able to read, edit, and execute files here.")).toBeTruthy();
  expect(screen.getByRole('button', { name: /^No, exit\s*当前选中$/ }).getAttribute('aria-current')).toBe('true');
  expect(container.querySelectorAll('.chat-message')).toHaveLength(0);
  expect(live.answer).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Yes, I trust this folder' })));
  expect(live.answer).toHaveBeenCalledExactlyOnceWith(live.projection.question!.id, 1);
  expect(client.prompt).not.toHaveBeenCalled();
});

it('updates one separate model/status strip while messages grow, with no HUD message bubbles', async () => {
  const footer = (percent: number) => ['─'.repeat(155), '❯ ', '─'.repeat(155), `  [Fable 5.1] ░░░░░░░░░░ ${percent}% | demo ${percent * 1000} tokens`, '  ⏸ manual mode on · ← for agents'];
  live.projection = projectConversation(['TEST COMPLETE', '', ...footer(3)], 7, 'claude');
  const view = mount(); await act(async () => {});
  const strip = screen.getByLabelText('会话状态');
  expect(strip.textContent).toContain('Fable 5.1');
  expect(strip.textContent).toContain('/project');
  expect(view.container.querySelectorAll('.chat-message')).toHaveLength(1);
  for (let count = 4; count <= 10; count++) {
    live.projection = projectConversation([`Reply ${count}`, '', ...footer(count)], 7, 'claude');
    view.rerender(<ChatView client={client} session={session} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} />);
    expect(screen.getByLabelText('会话状态')).toBe(strip);
    expect(view.container.querySelectorAll('.conversation-status')).toHaveLength(1);
    expect(view.container.querySelector('.chat-timeline .chat-markdown')?.textContent).toBe(`Reply ${count}`);
    expect(view.container.querySelector('.chat-timeline')?.textContent).not.toContain('Fable 5.1');
    expect(strip.textContent).toContain(`${count}%`);
    expect(view.container.querySelector('.chat-timeline hr')).toBeNull();
  }
});

it('loads history when an unbound stream becomes bound with an unchanged cursor', async () => {
  vi.mocked(client.chat).mockResolvedValueOnce({ ...read(), bound: false })
    .mockResolvedValueOnce({ ...read(), unchanged: true })
    .mockResolvedValue(read(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '已接续完整历史。' } }) + '\n'));
  mount(); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(client.chat).toHaveBeenLastCalledWith('chat-test');
  expect(screen.getByText('已接续完整历史。')).toBeTruthy();
});

it('locks prompt submission during approval while keeping the draft editable', async () => {
  live.projection.question = { id: 'approval', text: 'Do you want to proceed?', choices: [{ label: 'No', input: 'n\r' }] };
  const { container } = mount(); await act(async () => {});
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '确认后再发' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
  expect(client.prompt).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('确认后再发');
  expect(container.querySelector('.chat-compose-wrap .conversation-question')).toBeTruthy();
});

it('shows useful tool summaries and edit contents without a stale running spinner', async () => {
  const data = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/project/src/App.tsx', old_string: 'old code', new_string: 'new code' } }] } },
    { type: 'assistant', message: { role: 'assistant', content: '本轮已经结束。' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  vi.mocked(client.chat).mockResolvedValue(read(data));
  const { container } = mount(); await act(async () => {});
  expect(screen.getByText('src/App.tsx')).toBeTruthy();
  expect(screen.getByText('未收到结果')).toBeTruthy();
  expect(screen.getByText('old code')).toBeTruthy();
  expect(screen.getByText('new code')).toBeTruthy();
  expect(container.querySelector('.chat-tool .spin')).toBeNull();
});

it('queues a follow-up during native generation and restores send controls when idle', async () => {
  const activity = { state: 'working' as const, source: 'native_title', revision: 2, auto_send_ready: false };
  vi.mocked(client.queue).mockResolvedValue({ messages: [], activity });
  vi.mocked(client.queueAction).mockResolvedValue({ messages: [{ id: 'queued', text: '下一步完善测试', status: 'queued', revision: 1 }], activity });
  const view = render(<ChatView client={client} session={{ ...session, activity }} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} capabilities={['message_queue', 'activity']} />);
  await act(async () => {});
  vi.mocked(client.queue).mockResolvedValue({ messages: [{ id: 'queued', text: '下一步完善测试', status: 'queued', revision: 1 }], activity });
  fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '下一步完善测试' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '加入队列' })));
  expect(client.prompt).not.toHaveBeenCalled();
  expect(client.queueAction).toHaveBeenCalledWith(session.id, 'enqueue', expect.any(String), '下一步完善测试', undefined);
  expect(screen.getByText('待发送 · 1')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement).value).toBe('');
  view.rerender(<ChatView client={client} session={{ ...session, activity: { ...activity, state: 'idle', revision: 3 } }} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} capabilities={['message_queue', 'activity']} />);
  expect(screen.getByText('就绪')).toBeTruthy();
  expect((screen.getByRole('button', { name: '停止当前生成' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
});

it('uses decoded native activity until the desktop has an authoritative state', async () => {
  Object.assign(live.projection, { activity: 'working' });
  const activity = { state: 'unknown' as const, source: 'unknown', revision: 0, auto_send_ready: false };
  vi.mocked(client.queue).mockResolvedValue({ messages: [], activity });
  const view = render(<ChatView client={client} session={{ ...session, activity }} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} capabilities={['message_queue']} />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: '加入队列' })).toBeTruthy();
  view.rerender(<ChatView client={client} session={{ ...session, activity: { ...activity, source: 'interrupted', revision: 1 } }} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} capabilities={['message_queue']} />);
  expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
});

it('retains the same activity element and spinner through Claude repaint and history polls', async () => {
  const content = '正在检查项目结构。';
  const data = JSON.stringify({ uuid: 'same-message', type: 'assistant', message: { role: 'assistant', content } }) + '\n';
  vi.mocked(client.chat).mockResolvedValue(read(data));
  const project = (glyph: string) => projectConversation([content, '', `${glyph} Synthesizing…`], 2, 'claude');
  live.projection = project('✢');
  const view = mount(); await act(async () => {});
  const spinner = view.container.querySelector('.conversation-activity .spin');
  expect(spinner).toBeTruthy();
  for (const glyph of ['*', '·', '✶', '✻', '✽', '·', '*']) {
    live.projection = project(glyph);
    view.rerender(<ChatView client={client} session={session} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(view.container.querySelector('.conversation-activity .spin')).toBe(spinner);
    expect(view.container.querySelector('.chat-markdown li')).toBeNull();
    expect(screen.getAllByText('Synthesizing…')).toHaveLength(1);
    expect(screen.getAllByText(content)).toHaveLength(1);
  }
});
