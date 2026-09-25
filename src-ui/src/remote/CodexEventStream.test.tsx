// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CodexEventStream, mergeCodexMessages, type CodexPage } from './CodexEventStream';
import { ConversationMarkdown } from './ConversationMarkdown';
import type { ChatMessage } from '../lib/chat-transcript';

afterEach(cleanup);
const event = (method: string, params: Record<string, unknown> = {}) => ({ method, params: { threadId: 'root', turnId: 'turn', ...params } });
function page(messages: ReturnType<typeof event>[], start = 1, extra: Partial<CodexPage> = {}): CodexPage {
  return { epoch: 'epoch', cursor: start + messages.length - 1, reset: start === 1, online: true, complete: true, thread_id: 'root', events: messages.map((message, index) => ({ sequence: start + index, message })), ...extra };
}
const bootstrap = event('sinos/thread', { model: 'gpt-test', effort: 'high', cwd: '/project', status: { type: 'idle' } });

it('renders original Markdown before completion, with stable message identity and intact newlines', () => {
  const stream = new CodexEventStream();
  const first = stream.apply(page([bootstrap, event('turn/started', { turn: { id: 'turn', status: 'inProgress' } }), event('item/agentMessage/delta', { itemId: 'reply', delta: '**Changes**\n\n1. First\n2. Second\n   - Nested\n' })]));
  expect(first.available).toBe(true); expect(first.activity).toBe('working');
  const view = render(<ConversationMarkdown text={first.messages[0].content} />);
  expect(view.container.querySelectorAll('li')).toHaveLength(3);
  expect(view.container.querySelector('strong')?.textContent).toBe('Changes');
  const list = view.container.querySelector('ol');
  const next = stream.apply(page([event('item/agentMessage/delta', { itemId: 'reply', delta: '\n```ts\nconst x = 1;\n' })], 4));
  expect(next.messages[0].id).toBe(first.messages[0].id);
  view.rerender(<ConversationMarkdown text={next.messages[0].content} />);
  expect(view.container.querySelector('ol')).toBe(list);
  expect(view.container.querySelector('code')?.textContent).toContain('const x = 1;');
});

it('replays pages exactly once, delays authority until caught up, and ignores heartbeat renders', () => {
  const stream = new CodexEventStream();
  const first = page([bootstrap, event('item/agentMessage/delta', { itemId: 'a', delta: 'Hello' })], 1, { has_more: true });
  expect(stream.apply(first).available).toBe(false);
  const second = page([event('item/agentMessage/delta', { itemId: 'a', delta: ' world' })], 3);
  const value = stream.apply(second);
  expect(value.available).toBe(true);
  expect(stream.apply(second).messages[0].content).toBe('Hello world');
  const snapshot = stream.apply(page([], 4));
  expect(stream.apply(page([], 4))).toBe(snapshot);
  const replay = new CodexEventStream();
  replay.apply(first); expect(replay.apply(second).messages).toEqual(value.messages);
});

it('falls back on missing events or rollback and resets old messages when the server changes epoch', () => {
  const stream = new CodexEventStream();
  stream.apply(page([bootstrap, event('item/agentMessage/delta', { itemId: 'a', delta: 'Old' })]));
  expect(stream.apply(page([event('turn/completed', { turn: { status: 'completed' } })], 4)).available).toBe(false);
  const rollback = stream.apply(page([event('thread/reverted')], 5));
  expect(rollback.available).toBe(false); expect(rollback.messages).toEqual([]);
  expect(stream.apply(page([bootstrap], 1, { epoch: 'next' })).messages).toEqual([]);
  expect(stream.apply(page([], 2, { epoch: 'next', online: false })).available).toBe(false);
});

it('keeps item/plan/error order and treats the final plan text as authoritative', () => {
  const stream = new CodexEventStream();
  const value = stream.apply(page([bootstrap,
    event('item/started', { item: { id: 'a', type: 'agentMessage', text: 'First' } }),
    event('turn/plan/updated', { plan: [{ step: 'Build', status: 'inProgress' }] }),
    event('item/plan/delta', { itemId: 'p', delta: 'Partial plan' }),
    event('error', { error: { message: 'Network retry' }, willRetry: true }),
  ]));
  expect(value.messages.map(message => message.id)).toEqual(['a:0', 'plan-turn', 'p:0', 'error-5']);
  expect(value.messages[1].content).toContain('in_progress');
  const final = stream.apply(page([event('item/completed', { item: { id: 'p', type: 'plan', text: 'Final, corrected plan' } })], 6));
  expect(final.messages[2].content).toBe('Final, corrected plan');
});

it('streams command output and file patches before completion, preserving failures and moved paths', () => {
  const stream = new CodexEventStream();
  const first = stream.apply(page([bootstrap,
    event('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'npm test', cwd: '/project', status: 'inProgress' } }),
    event('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'Running tests\n' }),
    event('item/fileChange/patchUpdated', { itemId: 'patch', changes: [{ path: 'old.ts', kind: { type: 'update', move_path: 'new.ts' }, diff: '@@ -1 +1 @@\n-old\n+new' }] }),
  ]));
  expect(first.messages[0]).toMatchObject({ id: 'cmd', toolStatus: 'running', output: 'Running tests\n' });
  expect(first.messages[1].changes).toMatchObject({ 'old.ts': { move_path: 'new.ts', unified_diff: expect.stringContaining('+new') } });
  const final = stream.apply(page([event('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'failed', exitCode: 1, aggregatedOutput: null } })], 5));
  expect(final.messages[0]).toMatchObject({ toolStatus: 'failed', output: 'Running tests\n' });
});

it('shows only public reasoning summaries, excluding hooks and unrelated agent threads', () => {
  const stream = new CodexEventStream();
  const result = stream.apply(page([bootstrap,
    event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Checking files' }),
    event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 1, delta: 'Testing changes' }),
    event('item/completed', { item: { id: 'r2', type: 'reasoning', summary: ['Public'], content: ['Private'] } }),
    event('item/completed', { item: { id: 'h', type: 'hookPrompt', prompt: 'Internal' } }),
    event('item/agentMessage/delta', { threadId: 'foreign', itemId: 'x', delta: 'Other thread' }),
  ]));
  expect(result.messages.map(message => message.content)).toEqual(['Checking files\nTesting changes', 'Public']);
});

it('updates model/context and approval state independently of chat output', () => {
  const stream = new CodexEventStream();
  const first = stream.apply(page([bootstrap,
    event('thread/settings/updated', { threadSettings: { model: 'new-model', effort: 'xhigh', cwd: '/other' } }),
    event('thread/tokenUsage/updated', { tokenUsage: { modelContextWindow: 112000, last: { totalTokens: 32000 }, total: { totalTokens: 999999 } } }),
    event('item/commandExecution/requestApproval', { itemId: 'cmd' }),
  ]));
  expect(first.messages).toEqual([]); expect(first.activity).toBe('waiting');
  expect(first.status).toEqual({ model: 'new-model', effort: 'xhigh', cwd: '/other', contextRemaining: 80 });
  expect(stream.apply(page([event('thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } })], 5)).activity).toBe('waiting');
  expect(stream.apply(page([event('serverRequest/resolved')], 6)).activity).toBe('working');
  expect(stream.apply(page([event('turn/completed', { turn: { status: 'completed' } })], 7)).activity).toBe('idle');
});

it('streams MCP progress and then replaces it with the final error', () => {
  const stream = new CodexEventStream();
  const first = stream.apply(page([bootstrap,
    event('item/started', { item: { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'find', arguments: { q: 'test' }, status: 'inProgress' } }),
    event('item/mcpToolCall/progress', { itemId: 'mcp', message: 'Reading docs' }),
  ]));
  expect(first.messages[0]).toMatchObject({ toolName: 'docs/find', output: 'Reading docs', toolStatus: 'running' });
  const final = stream.apply(page([event('item/completed', { item: { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'find', arguments: {}, status: 'failed', result: null, error: { message: 'Unavailable' } } })], 4));
  expect(final.messages[0]).toMatchObject({ toolStatus: 'failed', output: expect.stringContaining('Unavailable') });
});

it.each([
  ['dynamicToolCall', { namespace: 'files', tool: 'read', arguments: {}, status: 'completed', contentItems: [{ type: 'inputText', text: 'Result' }], success: true }, 'files.read'],
  ['webSearch', { query: 'docs', action: { type: 'search', query: 'docs' } }, 'web_search'],
  ['imageView', { path: '/tmp/test.png' }, 'view_image'],
  ['imageGeneration', { revisedPrompt: 'A diagram', status: 'failed', failure: 'Unavailable' }, 'image_generation'],
  ['collabAgentToolCall', { tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: {}, status: 'completed' }, 'spawn_agent'],
  ['subAgentActivity', { kind: 'completed', agentPath: 'child' }, 'sub_agent'],
  ['sleep', { durationMs: 500 }, 'sleep'],
  ['enteredReviewMode', { review: 'Review current diff' }, 'review'],
  ['exitedReviewMode', { review: 'No issues found' }, 'review'],
  ['contextCompaction', {}, 'context_compaction'],
])('converts %s using app-server wire fields', (type, fields, toolName) => {
  const value = new CodexEventStream().apply(page([bootstrap, event('item/completed', { item: { id: 'tool', type, ...fields } })]));
  expect(value.messages[0]).toMatchObject({ id: 'tool', role: 'tool', toolName });
  if (type === 'exitedReviewMode') expect(value.messages[0].output).toBe('No issues found');
});

const message = (id: string, content: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({ id, content, role });
it('keeps native history, inserts live-only items before their following anchor, and avoids final/partial duplicates', () => {
  const history = [message('old', 'Earlier'), message('disk-user', 'Build it', 'user'), message('disk-reply', 'Here is the complete answer.')];
  const live = [message('live-user', 'Build it', 'user'), message('tool', 'Checking', 'tool'), message('live-reply', 'Here is the complete')];
  const merged = mergeCodexMessages(history, live);
  expect(merged.map(item => item.id)).toEqual(['old', 'live-user', 'tool', 'live-reply']);
  expect(mergeCodexMessages(merged, live)).toEqual(merged);
});

it('does not collapse ambiguous repeated user messages or unrelated prefixes', () => {
  const native = [message('a', 'Again', 'user'), message('b', 'Again', 'user')];
  expect(mergeCodexMessages(native, [message('c', 'Again', 'user')])).toHaveLength(3);
  expect(mergeCodexMessages([message('a', 'A longer previous answer')], [message('b', 'A longer previous')])).toHaveLength(2);
});
