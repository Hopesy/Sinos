// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { updateChatTranscript } from '../lib/chat-transcript';
import { ConversationTool } from './ConversationTool';
import { ConversationAttachments } from './ConversationAttachments';
import { mergeConversationTimeline, projectConversation } from './conversationProjection';

afterEach(cleanup);
const completed = (item: unknown) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } });

it('renders Codex plan steps as a read-only checklist, with distinct pending/running/completed states', () => {
  const view = render(<ConversationTool message={{ id: 'plan', role: 'tool', toolName: 'update_plan', toolStatus: 'done', content: JSON.stringify({ explanation: 'Check rendering', plan: [{ step: 'Read source', status: 'completed' }, { step: 'Fix parser', status: 'in_progress' }, { step: 'Run tests', status: 'pending' }] }) }} cwd="/work" active={false} />);
  expect(view.getByLabelText('执行计划').querySelectorAll('li')).toHaveLength(3);
  expect(view.container.querySelector('[data-state="in_progress"]')?.textContent).toContain('Fix parser');
  expect(view.queryByRole('checkbox')).toBeNull();
  expect(view.queryByRole('button')).toBeNull();
});

it('renders Codex structured file changes and retains move paths and exact diff text', () => {
  const parsed = updateChatTranscript(completed({ type: 'FileChange', id: 'patch', status: 'completed', changes: { '/work/old.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new', move_path: '/work/new.ts' }, '/work/added.ts': { type: 'add', content: 'added\n' }, '/work/deleted.ts': { type: 'delete', content: 'removed\n' } } }));
  const view = render(<ConversationTool message={parsed.messages[0]} cwd="/work" active={false} />);
  expect(view.container.textContent).toContain('/work/old.ts → /work/new.ts');
  expect(view.container.querySelector('.conversation-patch')?.textContent).toBe('@@ -1 +1 @@\n-old\n+new\n');
  expect(view.container.querySelector('.conversation-patch .added')?.textContent).toBe('+new\n');
  expect(view.container.querySelectorAll('.conversation-changes section')).toHaveLength(3);
});

it('shows inline native images, links remote media on demand and labels unavailable local attachments', () => {
  const parsed = updateChatTranscript(completed({ type: 'UserMessage', id: 'image', content: [{ type: 'image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }, { type: 'image', image_url: 'https://example.com/a.png' }, { type: 'local_image', path: '/work/a.png' }] }));
  const view = render(<ConversationAttachments items={parsed.messages[0].attachments} />);
  expect(view.container.querySelectorAll('img')).toHaveLength(1);
  expect(view.getByRole('link').getAttribute('href')).toBe('https://example.com/a.png');
  expect(view.container.textContent).toContain('图片：/work/a.png');
  expect(view.container.textContent).toContain('附件未包含可预览数据');
  expect(view.container.textContent).not.toContain('iVBOR');
});

// Exact visible output patterns from history_cell/* snapshots in Codex source.
it('converts MCP lifecycle and error output into activities instead of assistant bubbles', () => {
  const live = projectConversation(['• Called search.find_docs({"query":"ratatui styling","limit":3})', '  └ Error: network timeout', '', '• Calling workspace.inspect({"path":"README.md"})', '• Interrupted workspace.inspect({"path":"README.md"})'], 4, 'codex');
  expect(live.events.map(e => [e.kind, e.status])).toEqual([['activity', 'failed'], ['activity', 'running'], ['activity', 'failed']]);
  expect(live.events[0].text).toContain('search.find_docs');
});

it('recognizes errors, notices and historical approval decisions without making new approval buttons', () => {
  const live = projectConversation(['■ Message exceeds the maximum length of 1048576 characters (1048577 provided).', '⚠ MCP server unavailable', 'ⓘ This content cannot be shown', '  Trusted Access: https://example.com', '✔ You approved codex to run npm test this time', '✗ You did not approve codex to run npm publish'], 5, 'codex');
  expect(live.question).toBeNull();
  expect(live.events.map(e => [e.kind, e.status, e.notice])).toEqual([['error', 'failed', undefined], ['activity', 'done', 'warning'], ['activity', 'done', 'info'], ['activity', 'done', undefined], ['activity', 'failed', undefined]]);
  expect(live.events[2].text).toContain('https://example.com');
});

it('recognizes source web action labels and viewed-image summaries', () => {
  const rows = ['• Opened https://example.com/docs', '• Opened page', "• Searched for 'needle' in https://example.com/docs", "• Searched for 'needle'", '• Searched page https://example.com/docs', '• Viewed image very-long-screen…'];
  expect(projectConversation(rows, 5, 'codex').events.every(e => e.kind === 'activity')).toBe(true);
});

it('converts source sub-agent and review lifecycle banners into status records', () => {
  const rows = ['• Started `/root/test`', '• Interacted with `/root/test`', '• Waiting for 2 agents', '• Finished waiting', '• Completed `/root/test`', '• Context compacted · 2s', '>> Code review started: current changes <<'];
  const result = projectConversation(rows, rows.length - 1, 'codex');
  expect(result.events).toHaveLength(7);
  expect(result.events.every(e => e.kind === 'activity')).toBe(true);
  expect(result.events[2].status).toBe('running');
  expect(result.events[3].status).toBe('done');
});

it('reconciles full MCP signatures and shell commands while keeping distinct calls and truncated details', () => {
  const native = updateChatTranscript(completed({ type: 'McpToolCall', id: 'mcp', server: 'search', tool: 'find_docs', arguments: { limit: 3, query: 'ratatui styling' }, status: 'completed', result: { content: [{ type: 'text', text: 'found' }] } })).messages;
  const live = projectConversation(['• Called search.find_docs({"query":"ratatui styling","limit":3})', '  └ found'], 1, 'codex');
  expect(mergeConversationTimeline(live, native)).toHaveLength(1);
  expect(mergeConversationTimeline(live, [{ ...native[0], toolName: 'mcp__search__find_docs' }])).toHaveLength(1);
  const changed = projectConversation(['• Called search.find_docs({"query":"different","limit":3})'], 0, 'codex');
  expect(mergeConversationTimeline(changed, native)).toHaveLength(2);
  const truncated = projectConversation(['• Called search.find_docs({"query":"ratatui…'], 0, 'codex');
  expect(mergeConversationTimeline(truncated, native)).toHaveLength(2);
  const shell = [{ id: 'shell', role: 'tool' as const, toolName: 'exec_command', content: '{"cmd":"npm test"}', toolStatus: 'done' as const }];
  expect(mergeConversationTimeline(projectConversation(['• Ran npm test', '  └ passed'], 1, 'codex'), shell)).toHaveLength(1);
  expect(mergeConversationTimeline(projectConversation(['• Ran npm test -- --watch'], 0, 'codex'), shell)).toHaveLength(2);
});

it('handles a wrapped Called heading without consuming arbitrary prose as a tool', () => {
  const native = [{ id: 'mcp', role: 'tool' as const, toolName: 'workspace.inspect', content: '{"path":"README.md"}', toolStatus: 'done' as const }];
  const live = projectConversation(['• Called', '  └ workspace.inspect({"path":"README.md"})', '    structured output'], 2, 'codex');
  expect(mergeConversationTimeline(live, native)).toHaveLength(1);
  const prose = projectConversation(['• Explain this output:', '  Called search.find_docs({"query":"x"})'], 1, 'codex');
  expect(prose.events[0].kind).toBe('assistant');
});

it('keeps incremental tool output visible while the native call is still awaiting its result', () => {
  const native = [{ id: 'cmd', role: 'tool' as const, toolName: 'exec_command', content: '{"cmd":"npm test"}', toolStatus: 'running' as const }];
  const live = projectConversation(['• Running npm test', '  └ 12 tests passed', '    next suite running…'], 2, 'codex');
  const merged = mergeConversationTimeline(live, native);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ source: 'message', message: { output: '12 tests passed\n  next suite running…', toolStatus: 'running' } });
  expect(native[0]).not.toHaveProperty('output');
  const complete = [{ ...native[0], toolStatus: 'done' as const, output: '24 tests passed' }];
  expect(mergeConversationTimeline(live, complete)[0]).toMatchObject({ message: { output: '24 tests passed', toolStatus: 'done' } });
});
