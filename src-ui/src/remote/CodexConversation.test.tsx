// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TerminalConversation } from './TerminalConversation';
import { ConversationMarkdown } from './ConversationMarkdown';
import { mergeConversationTimeline, projectConversation } from './conversationProjection';

const decoders: TerminalConversation[] = [];
const decoder = (cols = 100, rows = 30) => { const value = new TerminalConversation(cols, rows, 'codex'); decoders.push(value); return value; };
afterEach(() => { cleanup(); decoders.splice(0).forEach(value => value.dispose()); });

// Fixtures follow Codex history_cell/messages.rs + markdown_render.rs and
// bottom_pane snapshots. The bytes are synthetic, not private user history.
it('renders nested and loose Codex lists during generation, preserving paragraphs and emphasis', async () => {
  const model = decoder();
  const first = await model.write('• \x1b[1mChanges\x1b[0m\r\n\r\n  • First item\r\n      • Nested item\r\n\r\n  • Second item');
  expect(first.events).toHaveLength(1);
  expect(first.events[0].text).toBe('**Changes**\n\n- First item\n    - Nested item\n\n- Second item');
  const view = render(<ConversationMarkdown text={first.events[0].text} terminal />);
  expect(view.container.querySelectorAll('li')).toHaveLength(3);
  expect(view.container.querySelector('li ul li')?.textContent).toBe('Nested item');
  expect(view.container.querySelector('strong')?.textContent).toBe('Changes');
  const next = await model.write('\r\n\r\n  A second paragraph.');
  expect(next.events[0].id).toBe(first.events[0].id);
  expect(next.events[0].text).toContain('\n\nA second paragraph.');
});

it('keeps status across composer repaint and long scrollback, then updates the model', async () => {
  const model = decoder(100, 12);
  const first = await model.write('• Ready\r\n\r\n› Ask Codex to do anything\r\n\r\n  gpt-5.4 xhigh fast · Context 88% left · /workspace');
  expect(first.terminalStatus).toEqual({ model: 'gpt-5.4 xhigh fast', lines: ['Context 88% left', '/workspace'] });
  expect(first.events.map(event => event.text)).toEqual(['Ready']);
  const long = await model.write('\x1b[2J\x1b[H' + ('  More output\r\n'.repeat(1050)));
  expect(long.terminalStatus?.model).toBe('gpt-5.4 xhigh fast');
  const changed = await model.write('\r\n› \r\n  gpt-5.5 high · Context 65% left · /workspace');
  expect(changed.terminalStatus?.model).toBe('gpt-5.5 high');
  expect(changed.events.some(event => event.text.includes('Context 65%'))).toBe(false);
});

it('does not join new list rows using stale VT wrap flags after a ratatui repaint', async () => {
  const model = decoder(30, 10);
  await model.write('a'.repeat(120));
  const result = await model.write('\x1b[1;1H• Items\x1b[K\x1b[2;1H  • One\x1b[K\x1b[3;1H  • Two\x1b[K\x1b[4;1H\x1b[J');
  expect(result.events[0].text).toBe('Items\n- One\n- Two');
});

it('pairs formatted terminal output with its native Markdown once, preserving the message key', () => {
  const live = projectConversation(['• **Changes**', '', '  • First', '  • Second'], 3, 'codex');
  const native = [{ id: 'reply', role: 'assistant' as const, content: '**Changes**\n\n- First\n- Second' }];
  const keys = new Map<string, string>();
  const rows = mergeConversationTimeline(live, native, keys);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: 'message', key: live.events[0].id });
  expect(mergeConversationTimeline({ events: [], question: null }, native, keys)[0]).toEqual(rows[0]);
  expect(mergeConversationTimeline(projectConversation(['• x += 1'], 0, 'codex'), [{ id: 'code', role: 'assistant', content: '`x = 1`' }])).toHaveLength(2);
});

it('recognizes Codex options with notes/navigation hints and free-form questions', () => {
  const options = ['  Question 1/2 (2 unanswered)', '  Choose an option.', '', '  › 1. Option 1  First choice.', '    2. Option 2  Second choice.', '', '  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt'];
  const result = projectConversation(options, 3, 'codex');
  expect(result.question?.choices).toHaveLength(2);
  expect(result.question?.text).toContain('Question 1/2');
  expect(result.question?.choices[1].input).toBe('\x1b[B\r');
  expect(result.events).toHaveLength(0);
  const freeform = ['  Question 1/1 (1 unanswered)', '  Share details.', '', '  › Type your answer (optional)', '', '  enter to submit answer | esc to interrupt'];
  expect(projectConversation(freeform, 3, 'codex').question).toMatchObject({ kind: 'text', text: 'Question 1/1 (1 unanswered)\n  Share details.' });
  expect(projectConversation(['```text', ...freeform, '```'], 7, 'codex').question).toBeNull();
});

it('keeps approval scope and the full command in its confirmation card', () => {
  const rows = ['  Would you like to run the following command?', '', '  Environment: remote', '  Reason: deployment', '  $ ssh server deploy.sh', '', '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel'];
  const result = projectConversation(rows, 9, 'codex');
  expect(result.question?.text).toContain('$ ssh server deploy.sh');
  expect(result.question?.text).toContain('Environment: remote');
  expect(result.question?.choices).toHaveLength(2);
  expect(result.events).toHaveLength(0);
});

it('keeps syntax-colored code in a copyable code block before the native message completes', async () => {
  const model = decoder();
  const result = await model.write('• Example:\r\n\r\n  \x1b[38;2;120;120;180mconst value = "**literal**";\x1b[0m\r\n  \x1b[38;2;180;120;120mconsole.log(value);\x1b[0m');
  const view = render(<ConversationMarkdown text={result.events[0].text} terminal />);
  expect(view.container.querySelector('pre code')?.textContent).toBe('const value = "**literal**";\nconsole.log(value);');
  expect(view.container.querySelector('strong')).toBeNull();
  expect(view.getByRole('button', { name: '复制代码' })).toBeTruthy();
  const next = await model.write('\x1b[38;2;180;120;120m // streamed\x1b[0m');
  expect(next.events[0].id).toBe(result.events[0].id);
});

it('restores rendered tables without turning separators into messages', () => {
  const result = projectConversation(['• **Key  Value**', '  ━━━  ━━━━━', '  A    One', '  B    Two'], 3, 'codex');
  const view = render(<ConversationMarkdown text={result.events[0].text} terminal />);
  expect(view.container.querySelectorAll('table')).toHaveLength(1);
  expect(view.container.querySelectorAll('tbody tr')).toHaveLength(2);
  expect(view.container.querySelector('th')?.textContent).toBe('Key');
});

it('preserves literal Markdown/HTML and footer-like prose instead of interpreting them as chrome', async () => {
  const result = await decoder().write('• Show **literal** and <div> as text.\r\n\r\n  Tip: keep this explanation.');
  const view = render(<ConversationMarkdown text={result.events[0].text} terminal />);
  expect(view.container.textContent).toContain('Show **literal** and <div> as text.');
  expect(view.container.textContent).toContain('Tip: keep this explanation.');
  expect(view.container.querySelector('strong')).toBeNull();
});

it('reconciles CJK soft wraps without erasing literal code punctuation', () => {
  const native = [{ id: 'cjk', role: 'assistant' as const, content: '这是需要保留换行语义的中文回复。\n\n`**literal**`\n\n```text\nx += 1\n```' }];
  const live = projectConversation(['• 这是需要保留换行', '  语义的中文回复。', '', '  \\*\\*literal\\*\\*', '', '  ```text', '  x += 1', '  ```'], 8, 'codex');
  expect(mergeConversationTimeline(live, native)).toHaveLength(1);
  const different = [{ ...native[0], content: native[0].content.replace('x += 1', 'x = 1') }];
  expect(mergeConversationTimeline(live, different)).toHaveLength(2);
});
