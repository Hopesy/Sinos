// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ClaudeEventStream, mergeClaudeMessages, type ClaudeTurn } from './ClaudeEventStream';
import { ConversationMarkdown } from './ConversationMarkdown';
import type { CodexPage } from './CodexEventStream';
import type { ChatMessage } from '../lib/chat-transcript';

const page = (events: Record<string, unknown>[], start = 0, overrides = {}): CodexPage => ({ epoch: 'epoch', cursor: start + events.length, reset: start === 0, online: true, complete: true, has_more: false, thread_id: 'session', events: events.map((message, i) => ({ sequence: start + i + 1, message })), ...overrides });
const begin = [{ kind: 'session', session: 'session', model: 'Opus', cwd: '/work' }, { kind: 'start', turn: 'turn', text: 'hello' }];
const delta = (text: string, index = 0) => ({ kind: 'text', turn: 'turn', step: 0, index, text });
it('renders original lists/emphasis before the turn finishes, with immutable snapshots and stable IDs', () => {
  const stream = new ClaudeEventStream();
  const first = stream.apply(page([...begin, delta('1. **First**\n')]));
  expect(first.available).toBe(true); expect(first.activity).toBe('working');
  const view = render(<ConversationMarkdown text={first.turns[0].messages[0].content} />);
  expect(view.container.querySelector('ol li strong')?.textContent).toBe('First');
  const next = stream.apply(page([delta('2. Second\n')], 3));
  expect(first.turns[0].messages[0].content).toBe('1. **First**\n');
  expect(next.turns[0].messages[0].id).toBe(first.turns[0].messages[0].id);
  expect(stream.apply(page([], 4))).toBe(next);
  view.rerender(<ConversationMarkdown text={next.turns[0].messages[0].content} />);
  expect(view.container.querySelectorAll('li')).toHaveLength(2);
});
it('deduplicates replayed pages and refuses gaps or incomplete catch-up', () => {
  const stream = new ClaudeEventStream(), first = page([...begin, delta('hello')]);
  stream.apply(first);
  expect(stream.apply(first).turns[0].messages[0].content).toBe('hello');
  expect(stream.apply(page([delta('lost')], 5)).available).toBe(false);
  expect(new ClaudeEventStream().apply(page(begin, 0, { has_more: true })).available).toBe(false);
});
it('keeps text blocks separate from incremental tool arguments and completes only on turn completion', () => {
  const stream = new ClaudeEventStream();
  const first = stream.apply(page([...begin, delta('Checking\n'), { kind: 'tool', turn: 'turn', step: 0, index: 1, id: 'tool-1', name: 'Bash' }, { kind: 'input', turn: 'turn', step: 0, index: 1, text: '{"command":' }]));
  expect(first.turns[0].messages[1].content).toBe('{"command":');
  const next = stream.apply(page([{ kind: 'input', turn: 'turn', step: 0, index: 1, text: '"pwd"}' }, { kind: 'step', turn: 'turn', step: 0 }], 5));
  expect(next.activity).toBe('working'); expect(next.turns[0].messages[1].toolStatus).toBe('running');
  expect(JSON.parse(next.turns[0].messages[1].content)).toEqual({ command: 'pwd' });
  const done = stream.apply(page([{ kind: 'result', turn: 'turn', id: 'tool-1', text: '/work', failed: false }, { kind: 'complete', turn: 'turn', reason: 'answer' }], 7));
  expect(done.activity).toBe('idle'); expect(done.turns[0].messages[1]).toMatchObject({ output: '/work', toolStatus: 'done' });
});
it('retains the footer through text-only frames, and resets it for a different session', () => {
  const stream = new ClaudeEventStream();
  stream.apply(page([{ ...begin[0], percent: 17 }, begin[1]]));
  expect(stream.apply(page([delta('hello')], 2)).status).toEqual({ model: 'Opus', lines: ['上下文已用 17%'] });
  const cleared = stream.apply(page([{ kind: 'session', session: 'new', model: 'Sonnet' }], 0, { epoch: 'new', thread_id: 'new' }));
  expect(cleared.turns).toEqual([]); expect(cleared.status?.model).toBe('Sonnet');
});
it('merges current turns without duplicating repeated older prompts or losing native attachments', () => {
  const native: ChatMessage[] = [{ id: 'old:0', role: 'user', content: 'hello' }, { id: 'old-answer:0', role: 'assistant', content: 'old answer' }, { id: 'new:0', role: 'user', content: 'hello', attachments: [{ kind: 'image', src: 'data:image/png;base64,AA==', label: 'image' }] }, { id: 'answer:0', role: 'assistant', content: '**New** answer' }];
  const turn: ClaudeTurn = { id: 'turn', prompt: 'hello', messages: [{ id: 'live', role: 'assistant', content: '**New** answer' }], complete: true };
  const messages = mergeClaudeMessages(native, [turn]);
  expect(messages.map(m => m.content)).toEqual(['hello', 'old answer', 'hello', '**New** answer']);
  expect(messages[2].attachments).toHaveLength(1); expect(messages[3].id).toBe('live');
});
it('marks interrupted tools stopped without claiming they succeeded', () => {
  const live = new ClaudeEventStream().apply(page([...begin, { kind: 'tool', turn: 'turn', step: 0, index: 0, id: 't', name: 'Bash' }, { kind: 'complete', turn: 'turn', reason: 'aborted' }]));
  expect(live.turns[0].messages[0].toolStatus).toBe('failed');
  expect(live.activity).toBe('idle');
});

it('does not consume a previously bound identical prompt before the next disk row is flushed', () => {
  const native: ChatMessage[] = [{ id: 'user:0', role: 'user', content: 'again' }, { id: 'answer:0', role: 'assistant', content: 'same answer' }];
  const known = new Map<string, string>();
  const first: ClaudeTurn = { id: 'first', prompt: 'again', complete: true, messages: [{ id: 'live-1', role: 'assistant', content: 'same answer' }] };
  mergeClaudeMessages(native, [first], known);
  const second: ClaudeTurn = { id: 'second', prompt: 'again', complete: false, messages: [{ id: 'live-2', role: 'assistant', content: 'same' }] };
  expect(mergeClaudeMessages(native, [first, second], known).map(m => m.content)).toEqual(['again', 'same answer', 'again', 'same']);
  expect(mergeClaudeMessages([...native, { id: 'new:0', role: 'user', content: 'again' }], [first, second], known).map(m => m.content)).toEqual(['again', 'same answer', 'again', 'same']);
});
