// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { TerminalConversation } from './TerminalConversation';
import { projectConversation, supplementalEvents, mergeConversationTimeline, multiChoiceInput } from './conversationProjection';
import { updateChatTranscript } from '../lib/chat-transcript';
import { trustMenu } from './fixtures/terminalMenus';
import { claudeTrustStartup } from './fixtures/claudeTrustStartup';
import { claudeStatusReplay } from './fixtures/claudeStatusReplay';

const models: TerminalConversation[] = [];
const model = (cols = 80) => { const value = new TerminalConversation(cols, 24); models.push(value); return value; };
afterEach(() => { models.forEach(value => value.dispose()); models.length = 0; });

it('keeps the captured Claude composer borders and HUD out of mobile messages', async () => {
  const { cols, rows, frames } = claudeStatusReplay;
  const decoder = new TerminalConversation(cols, rows, 'claude'); models.push(decoder);
  for (const frame of frames) await decoder.write(frame);
  const result = await decoder.write('');
  expect(result.events.some(event => /─|manual mode|░|\[Fable/.test(event.text))).toBe(false);
  expect(result.terminalStatus?.model).toBe('Fable 5.1');
  expect(result.terminalStatus?.lines.join(' ')).toContain('3%');
  expect(result.terminalStatus?.lines.join(' ')).toContain('27106 tokens');
  expect(result.events.some(event => event.text === 'TEST COMPLETE')).toBe(true);
  expect(result.events.some(event => /Claude Code v/.test(event.text))).toBe(false);
});

it('does not glue repainted composer rules to a prompt after wrapped chat scrollback', async () => {
  const cols = 60, decoder = new TerminalConversation(cols, 18, 'claude'); models.push(decoder);
  await decoder.write('A'.repeat(cols * 30));
  const footer = (used: number) => `\x1b[11;1H${'─'.repeat(cols)}\x1b[12;1H❯ \x1b[K\x1b[13;1H${'─'.repeat(cols)}\x1b[14;1H  [Fable 5.1] ░░░░░░░░░░ ${used}% | demo\x1b[K\x1b[15;1H  ⏸ manual mode on · ← for agents\x1b[K`;
  for (let used = 1; used <= 20; used++) {
    const result = await decoder.write(footer(used));
    expect(result.events.some(event => /─|❯|manual mode|\[Fable/.test(event.text))).toBe(false);
    expect(result.terminalStatus?.model).toBe('Fable 5.1');
    expect(result.terminalStatus?.lines[0]).toBe(`${used}% | demo`);
  }
});

it('preserves code and prose that resemble a HUD and replaces only actual bordered footer state', () => {
  const rule = '─'.repeat(60);
  const footer = [rule, '❯ ', rule, '  [Fable 5.1] ░░░░░░░░░░ 3% | demo 32638 tokens', '  ⏸ manual mode on · ← for agents'];
  const examples = ['```text', ...footer, '```', '', '[Example] 3% | demo 32638 tokens', 'manual mode on'];
  const result = projectConversation([...examples, '', ...footer], examples.length + footer.length, 'claude');
  expect(result.events.map(event => event.text).join('\n\n')).toContain(examples.map(line => line.trimEnd()).join('\n'));
  expect(result.terminalStatus?.model).toBe('Fable 5.1');
  const cleared = projectConversation([...footer, '', rule, '❯ ', rule], 10, 'claude');
  expect(cleared.terminalStatus).toBeUndefined();
  expect(cleared.events).toHaveLength(0);
});

it('preserves real Claude word and wide-character wraps while separating stale repaint flags', async () => {
  const decoder = new TerminalConversation(21, 18, 'claude'); models.push(decoder);
  const text = '12345678901234567890中文 mixed words and 继续检查';
  expect((await decoder.write(text)).events[0].text).toBe(text);
  decoder.reset();
  const code = '```text\r\n' + '─'.repeat(63) + '\r\n```';
  expect((await decoder.write(code)).events[0].text).toBe(code.replaceAll('\r\n', '\n'));
});

it.each([0, 37])('recognizes the captured Windows Claude startup menu, chunk size %s', async chunkSize => {
  const { cols, rows, data } = claudeTrustStartup;
  const decoder = new TerminalConversation(cols, rows, 'claude'); models.push(decoder);
  if (chunkSize) for (let offset = 0; offset < data.length; offset += chunkSize) await decoder.write(data.slice(offset, offset + chunkSize));
  const result = await decoder.write(chunkSize ? '' : data);
  expect(result.question).toMatchObject({ kind: 'choice', cursor: 0, choices: [
    { label: 'No, exit', input: '\r' },
    { label: 'Yes, I trust this folder', input: '\x1b[B\r' },
  ] });
  expect(result.question?.text).toContain('C:\\Projects\\demo');
  expect(result.question?.text).toContain('Accessing workspace:');
  expect(result.question?.text).toContain('(Like your own code, a well-known open source project, or work from your team). If');
  expect(result.question?.text).toContain("Claude Code'll be able to read, edit, and execute files here.");
  expect(result.events).toEqual([]);
});

it('converts the unnumbered Claude trust menu with its directory, warning and current selection', async () => {
  const decoder = model(45);
  const result = await decoder.write(trustMenu().join('\r\n'));
  expect(result.events).toEqual([]);
  expect(result.question).toMatchObject({ kind: 'choice', cursor: 0, choices: [
    { label: 'No, exit', input: '\r' },
    { label: 'Yes, I trust this folder', input: '\x1b[B\r' },
  ] });
  expect(result.question?.text).toBe(trustMenu().slice(0, 9).join('\n').trim());
  const updated = await decoder.write('\x1b[H\x1b[2J' + trustMenu(1).join('\r\n'));
  expect(updated.question?.id).not.toBe(result.question?.id);
  expect(updated.question).toMatchObject({ cursor: 1, choices: [
    { label: 'No, exit', input: '\x1b[A\r' },
    { label: 'Yes, I trust this folder', input: '\r' },
  ] });
});

it('converts setup menus after earlier chat prompts and keeps wrapped labels', () => {
  const lines = ['❯ Earlier request', '', 'Choose a theme:', '', '  Dark', '    High contrast', '❯ Light', '  System', '', '↑/↓ to navigate', 'Enter to select'];
  const result = projectConversation(lines);
  expect(result.question).toMatchObject({ text: 'Choose a theme:', cursor: 1, choices: [
    { label: 'Dark\nHigh contrast', input: '\x1b[A\r' }, { label: 'Light', input: '\r' }, { label: 'System', input: '\x1b[B\r' },
  ] });
  expect(result.events[0]).toMatchObject({ kind: 'user', text: 'Earlier request' });
  expect(projectConversation(['Select a login method', '  1. Subscription', '❯ 2. API key', 'Enter to confirm']).question?.cursor).toBe(1);
  expect(projectConversation(['请选择主题', '❯ 深色', '  浅色', '按回车确认，Esc 取消']).question?.choices).toHaveLength(2);
});

it('does not turn old, quoted, incomplete or ambiguous arrow menus into clickable approvals', () => {
  const menu = trustMenu();
  for (const lines of [
    ['```text', ...menu, '```'], ['~~~text', ...menu], menu.map(line => '    ' + line),
    [...menu, 'Completed', '❯'], menu.slice(0, -1),
    menu.map(line => line === '  Yes, I trust this folder' ? '❯ Yes, I trust this folder' : line),
    ['Choose a theme:', '❯ 1. Dark', '  3. Light', 'Press Enter to confirm'],
    ['Choose a theme:', '❯ Dark', 'Press Enter to confirm'],
    ['Choose a theme:', '❯ [ ] Dark', '  [ ] Light', 'Press Enter to confirm'],
    ['Choose a theme:', ...Array.from({ length: 10 }, (_, i) => `${i ? ' ' : '❯'} Theme ${i}`), 'Press Enter to confirm'],
  ]) expect(projectConversation(lines).question, lines.join('\n')).toBeNull();
  expect(projectConversation(menu, 0).question).toBeNull();
});

it('decodes split ANSI, carriage return and erased progress without a DOM terminal', async () => {
  const decoder = model();
  await decoder.write('\x1b[3');
  await decoder.write('2m⠋ 正在检查 10%\x1b[0m');
  const result = await decoder.write('\r\x1b[2K✓ 检查完成\r\n\r\n已经修复布局。');
  expect(result.events.map(event => event.text)).toEqual(['检查完成', '已经修复布局。']);
  expect(result.events[0].status).toBe('done');
  expect(document.querySelector('canvas, .xterm, textarea')).toBeNull();
});

it('joins terminal-wrapped Chinese prose without losing characters', async () => {
  const decoder = model(20);
  const text = '这是需要完整显示在手机聊天界面里的中文内容。';
  const result = await decoder.write(text);
  expect(result.events[0].text).toBe(text);
});

it('preserves spaces at English wrap boundaries', async () => {
  const text = '1234567890123456789 next word';
  expect((await model(20).write(text)).events[0].text).toBe(text);
});

it('removes OSC titles, colors, separators and the empty input prompt', async () => {
  const result = await model().write('\x1b]0;private title\x07\x1b[36m现在开始检查\x1b[0m\r\n─────────────────\r\n› ');
  expect(result.events.map(event => event.text)).toEqual(['现在开始检查']);
});

it('updates an overwritten screen instead of appending duplicate message frames', async () => {
  const decoder = model();
  await decoder.write('正在生成第一版');
  const result = await decoder.write('\x1b[H\x1b[2J已生成最终版本');
  expect(result.events.map(event => event.text)).toEqual(['已生成最终版本']);
  decoder.reset();
  expect((await decoder.write('已生成最终版本')).events).toHaveLength(1);
});

it('retains the complete command and choices, and maps the explicit selection only', () => {
  const result = projectConversation(['Would you like to run the following command?', '', '$ npm test', '', '› 1. Yes, proceed', '  2. No, cancel', 'Press enter to confirm'], 6);
  expect(result.question?.text).toContain('$ npm test');
  expect(result.question?.choices).toEqual([{ label: 'Yes, proceed', input: '\r' }, { label: 'No, cancel', input: '\x1b[B\r' }]);
});

it('never treats a numbered explanation or a past question as an active approval', () => {
  expect(projectConversation(['1. Read the file', '2. Update the UI']).question).toBeNull();
  expect(projectConversation(['Do you want to proceed?', '› 1. Yes', '2. No', 'Completed successfully', '› ']).question).toBeNull();
  expect(projectConversation(['```text', 'Do you want to proceed?', '› 1. Yes', '2. No']).question).toBeNull();
  expect(projectConversation(['> This is a quoted explanation.']).events[0].kind).toBe('assistant');
});

it('projects yes/no prompts and press-enter prompts into normal choice cards', () => {
  expect(projectConversation(['Do you trust this folder? [y/N]']).question?.choices.map(choice => choice.input)).toEqual(['y\r', 'n\r']);
  expect(projectConversation(['Signed in successfully.', 'Press Enter to continue']).question?.choices).toEqual([{ label: '继续', input: '\r' }]);
});

it('replaces converted fragments with native messages but keeps uncovered errors and progress', () => {
  const projection = projectConversation(['› 检查这个项目', '', '已经完成布局调整。', '', '✓ 检查 src/App.tsx', 'Error: 网络中断']);
  const events = supplementalEvents(projection, [{ id: 'a', role: 'assistant', content: '已经完成布局调整。\n现在可以在手机上使用。' }], ['检查这个项目']);
  expect(events.map(event => event.text)).toEqual(['检查 src/App.tsx', 'Error: 网络中断']);
  expect(supplementalEvents(projectConversation(['### 这次做了什么']), [{ id: 'a', role: 'assistant', content: '已完成。\n### 这次做了什么\n- 更新界面' }])).toHaveLength(0);
});

it('preserves code punctuation, case, role and repeated occurrences during reconciliation', () => {
  const native = [{ id: 'u', role: 'user' as const, content: '继续' }, { id: 'a', role: 'assistant' as const, content: 'x = 1\nconst ID = 42;' }];
  const events = projectConversation(['› 继续', '', '继续', '', 'x += 1', '', 'const id = 42;', '', '› 继续']);
  expect(supplementalEvents(events, native).map(event => event.text)).toEqual(['继续', 'x += 1', 'const id = 42;', '继续']);
  expect(supplementalEvents(projectConversation(['收到', '', '收到']), [{ id: 'a', role: 'assistant', content: '收到' }])).toHaveLength(1);
});

it('keeps converted progress between native messages and folds tool output into its card', () => {
  const native = [{ id: 'u', role: 'user' as const, content: '检查布局' }, { id: 't', role: 'tool' as const, toolName: 'Read', content: '{"file_path":"src/App.tsx"}', output: 'Read 142 lines' }, { id: 'a', role: 'assistant' as const, content: '布局检查完成。' }];
  const result = mergeConversationTimeline(projectConversation(['› 检查布局', '', '● Read(src/App.tsx)', '', 'Read 142 lines', '', '✓ 检查 100%', '', '布局检查完成。']), native);
  expect(result.map(row => row.source === 'message' ? row.message.id : row.event.text)).toEqual(['u', 't', '检查 100%', 'a']);
});

it('retains literal borders and indented code, and never activates fenced examples', () => {
  const text = ['~~~text', '│ literal pipe │', 'Do you want to proceed?', '› 1. Yes', '2. No', '~~~'];
  expect(projectConversation(text).question).toBeNull();
  expect(projectConversation(text).events[0].text).toBe(text.join('\n'));
  expect(projectConversation(['    Do you want to proceed?', '    › 1. Yes', '    2. No']).question).toBeNull();
  expect(projectConversation(['    x += 1']).events[0].text).toBe('    x += 1');
});

it('keeps wrapped choice labels and rejects non-consecutive menu numbering', () => {
  const result = projectConversation(['Do you want to proceed?', '› 1. Yes, allow commands', '     only in this workspace', '  2. No, cancel', 'Press enter to confirm']);
  expect(result.question?.choices[0].label).toBe('Yes, allow commands\nonly in this workspace');
  expect(projectConversation(['Do you want to proceed?', '› 1. Yes', '3. No']).question).toBeNull();
});

it('retains orphan tool results at a history page boundary and joins them after prepend', () => {
  const result = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Result at page boundary' }] } }) + '\n';
  expect(updateChatTranscript(result).messages[0].output).toBe('Result at page boundary');
  const call = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: 'src/App.tsx' } }] } }) + '\n';
  const messages = updateChatTranscript(call + result).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0].toolName).toBe('Read');
  expect(messages[0].output).toBe('Result at page boundary');
});

it('converts only explicit multi-select menus and computes checkbox deltas from the current cursor', () => {
  const result = projectConversation(['Which areas should change?', '› [x] Layout', '  [ ] Colors', '  [ ] Tests', 'Space to select, Enter to confirm']);
  expect(result.question?.kind).toBe('multi');
  expect(multiChoiceInput(result.question!, [1, 2])).toBe(' \x1b[B \x1b[B \r');
  expect(multiChoiceInput(result.question!, [0])).toBe('\r');
  expect(projectConversation(['Which areas should change?', '- [ ] Layout', '- [ ] Colors']).question).toBeNull();
  expect(projectConversation(['```', 'Which areas should change?', '› [x] Layout', '  [ ] Colors', 'Space to select, Enter to confirm', '```']).question).toBeNull();
});

it('offers a free-text answer only with an explicit input hint outside code', () => {
  const lines = ['你希望采用什么配色？', '', 'Type your answer:'];
  expect(projectConversation(lines).question?.kind).toBe('text');
  expect(projectConversation(['你希望采用什么配色？']).question).toBeNull();
  expect(projectConversation(['~~~', ...lines, '~~~']).question).toBeNull();
});

it('reads native CLI activity while keeping terminal titles out of chat content', async () => {
  const decoder = new TerminalConversation(80, 24, 'codex'); models.push(decoder);
  expect((await decoder.write('\x1b]0;⠋ workspace\x07')).activity).toBe('working');
  expect((await decoder.write('\x1b]0;[ ! ] Action Required\x07')).activity).toBe('waiting');
  const result = await decoder.write('\x1b]0;workspace\x07');
  expect(result.activity).toBe('idle'); expect(result.events).toHaveLength(0);
});

it('keeps every Claude spinner frame in one activity row instead of alternating with Markdown', async () => {
  // Claude Code 2.1.263 includes both a middle dot and an ASCII asterisk in
  // its native spinner; the latter otherwise becomes a Markdown list bullet.
  const decoder = new TerminalConversation(100, 24, 'claude'); models.push(decoder);
  await decoder.write('正在检查项目结构。\r\n\r\n');
  let id: string | undefined;
  for (const glyph of ['·', '✢', '*', '✳', '✶', '✻', '✽', '✻', '✶', '*', '✢', '·']) {
    const result = await decoder.write(`\r\x1b[2K${glyph} Synthesizing… (12s · ↓ 180 tokens)`);
    expect(result.events).toHaveLength(2);
    const activity = result.events[1];
    expect(activity).toMatchObject({ kind: 'activity', status: 'running', text: 'Synthesizing… (12s · ↓ 180 tokens)' });
    if (id) expect(activity.id).toBe(id); else id = activity.id;
  }
});

it('preserves ordinary dots, Markdown lists and code when recognizing Claude progress', () => {
  const prose = ['* First item', '* Second item', '· 普通说明', '2 * 3 = 6', '```text', '* Synthesizing…', '· Synthesizing…', '```'];
  expect(projectConversation(prose, prose.length - 1, 'claude').events).toEqual([{ id: 'output-0', kind: 'assistant', text: prose.join('\n') }]);
  const indented = ['    * Synthesizing…'];
  expect(projectConversation(indented, 0, 'claude').events[0].text).toBe(indented[0]);
  expect(projectConversation(['* Synthesizing…'], 0, 'codex').events[0].kind).toBe('assistant');
  expect(projectConversation(['· Synthesizing... (esc to interrupt)'], 0, 'claude').events[0]).toMatchObject({ kind: 'activity', text: 'Synthesizing...' });
});
