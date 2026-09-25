import type { ChatMessage } from '../lib/chat-transcript';
import { claudeChrome, type TerminalStatus } from './claudeChrome';
import { codexToolMatches, projectCodex } from './codexProjection';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export interface ConversationEvent {
  id: string;
  kind: 'user' | 'assistant' | 'activity' | 'error';
  text: string;
  status?: 'running' | 'done' | 'failed';
  terminal?: boolean;
  notice?: 'info' | 'warning';
}
export interface ConversationChoice { label: string; input: string; checked?: boolean }
export interface ConversationQuestion { id: string; text: string; choices: ConversationChoice[]; kind?: 'choice' | 'multi' | 'text'; cursor?: number }
export interface ConversationProjection { events: ConversationEvent[]; question: ConversationQuestion | null; activity?: 'working' | 'waiting' | 'idle'; terminalStatus?: TerminalStatus }

function codeLines(lines: string[]) {
  const result = new Set<number>();
  let fence = '', length = 0;
  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      result.add(index);
      if (marker?.[0] === fence && marker.length >= length && line.trim() === marker) fence = '';
    } else if (marker) {
      result.add(index); fence = marker[0]; length = marker.length;
    } else if (/^(?: {4}|\t)/.test(line)) result.add(index);
  });
  return result;
}
const chrome = /^(?:[\s─━═┄┈╭╮╰╯┌┐└┘├┤┬┴┼│┃+-]{3,}|[›❯>]\s*|(?:\? for shortcuts|\/help for help|esc to interrupt|press esc to interrupt|ctrl\+c to interrupt).*|(?:Claude Code|OpenAI Codex|Codex CLI)\s+v?\d.*)$/i;
const questionStart = /(?:do you (?:want|trust)|would you like|allow .*(?:\?|:)|(?:proceed|continue)\?\s*$|是否(?:允许|继续|执行|信任)|要继续吗|允许.*[？?])/i;
const menuHint = /^(?:(?:press\s+)?(?:enter|return)\b|esc\b|tab to\b|use (?:the )?(?:arrow|↑|↓)|[↑↓←→↵]|按|使用.*(?:选择|方向键))/i;
const menuConfirm = /\b(?:enter|return)\b.*\b(?:confirm|select|continue|submit)\b|(?:回车|Enter).*(?:确认|选择|继续|提交)/i;
const menuMarker = /^( {0,3})([›❯>])( +)(\S.*)$/;
type Interaction = { question: ConversationQuestion; start: number; end: number };

/** An active arrow menu has a visible cursor, aligned choices and a trailing
 * keyboard legend. Read the whole prompt, not just its last explanatory line.
 * No input is emitted here; the guarded answer endpoint handles explicit taps. */
function findArrowMenu(lines: string[], cursorLine: number, code: Set<number>, tail: number): Interaction | null {
  let footer = tail;
  while (footer >= 0 && (!lines[footer].trim() || (!code.has(footer) && menuHint.test(lines[footer].trim())))) footer--;
  footer++;
  if (footer > tail || !menuConfirm.test(lines.slice(footer, tail + 1).join(' '))) return null;
  const markers = lines.slice(Math.max(0, footer - 35), footer).flatMap((line, offset) => {
    const index = Math.max(0, footer - 35) + offset;
    const match = menuMarker.exec(line);
    return match && !code.has(index) ? [{ index, match }] : [];
  });
  const selected = markers.at(-1);
  if (!selected) return null;
  const { index: active, match } = selected;
  const column = match[1].length + match[2].length + match[3].length;
  const row = (index: number) => {
    if (index === active) return match[4];
    const line = lines[index];
    return line?.startsWith(' '.repeat(column)) && /\S/.test(line[column] || '') ? line.slice(column) : null;
  };
  const continuation = (index: number) => lines[index]?.startsWith(' '.repeat(column + 2)) && lines[index].trim();
  let first = active;
  while (first > 0 && (row(first - 1) || continuation(first - 1))) first--;
  if (cursorLine < first) return null;
  const options: { label: string; selected: boolean }[] = [];
  for (let i = first; i < footer; i++) {
    if (!lines[i].trim()) continue;
    const label = row(i);
    if (!label && continuation(i) && options.length) { options[options.length - 1].label += `\n${lines[i].trim()}`; continue; }
    if (!label || /^(?:[›❯>]|\[[ xX✓]\]|[☐☑]|`{3,}|~{3,})/.test(label)) return null;
    options.push({ label, selected: i === active });
  }
  if (options.length < 2 || options.length > 9) return null;
  // Numbered setup menus use the same navigation, but gaps, mixed numbering
  // and truncated menus cannot safely be mapped to relative arrow presses.
  const numbers = options.map(option => /^([1-9])[.)]\s+([\s\S]+)$/.exec(option.label));
  if (numbers.some(Boolean)) {
    if (!numbers.every((number, index) => number && Number(number[1]) === index + 1)) return null;
    options.forEach((option, index) => { option.label = numbers[index]![2]; });
  }
  let start = first - 1;
  while (start >= Math.max(0, first - 25)) {
    const line = lines[start];
    // CLI renderers keep explanatory text after the question on the same
    // visual line. The active menu's cursor/choices/footer establish that it
    // is interactive; the prompt's question mark need not end that line.
    if (!code.has(start) && (questionStart.test(line) || /[?？](?:\s|$)/.test(line) || /^(?:(?:select|choose)\b|请选择|选择)/i.test(line.trim()))) break;
    if (/^[›❯>]\s|^\s*(`{3,}|~{3,})/.test(line)) return null;
    start--;
  }
  if (start < Math.max(0, first - 25)) return null;
  if (/^\s*Question \d+\/\d+\b/.test(lines[start - 1] || '')) start--;
  // Claude's trust prompt places the directory immediately above its safety
  // explanation. Keep it in the card so consent retains its actual scope.
  let directory = start - 1;
  while (directory >= 0 && !lines[directory].trim()) directory--;
  if (directory >= 0 && !code.has(directory) && /^(?:[A-Za-z]:[\\/]|\/|~\/|\\\\)\S/.test(lines[directory].trim())) {
    start = directory;
    let heading = directory - 1;
    while (heading >= 0 && !lines[heading].trim()) heading--;
    if (heading >= 0 && !code.has(heading) && /^(?:Accessing workspace|Working directory|Workspace|工作目录)[:：]$/i.test(lines[heading].trim())) start = heading;
  }
  const text = lines.slice(start, first).join('\n').trim();
  const cursor = options.findIndex(option => option.selected);
  const choices = options.map((option, index) => ({ label: option.label, input: `${(index < cursor ? '\x1b[A' : '\x1b[B').repeat(Math.abs(index - cursor))}\r` }));
  return { question: { id: JSON.stringify(['menu', text, options.map(option => option.label), cursor]), kind: 'choice', text, choices, cursor }, start, end: lines.length };
}
// Only turn an actual interactive prompt into controls. Numbered prose and
// quoted examples must remain prose. Keep the original request and command.
function findQuestion(lines: string[], cursorLine: number, tool?: string | null, renderedCode: ReadonlySet<number> = new Set()): Interaction | null {
  let start = -1;
  const code = codeLines(lines);
  renderedCode.forEach(index => code.add(index));
  let tailIndex = lines.length - 1;
  while (tailIndex >= 0 && !lines[tailIndex].trim()) tailIndex--;
  const hint = lines[tailIndex]?.trim() || '';
  if (tool === 'codex' && menuConfirm.test(hint) && /esc.*interrupt/i.test(hint) && !code.has(tailIndex)) {
    const input = lines.findLastIndex((line, index) => index < tailIndex && !code.has(index) && /^\s{0,3}› Type your answer\b/i.test(line));
    if (input >= 0 && cursorLine >= input) {
      let first = input - 1;
      while (first >= Math.max(0, input - 12) && !/^\s*Question \d+\/\d+\b/.test(lines[first])) first--;
      if (first >= Math.max(0, input - 12)) {
        const text = lines.slice(first, input).join('\n').trim();
        return { question: { id: JSON.stringify(['codex-text', text]), kind: 'text', text, choices: [] }, start: first, end: lines.length };
      }
    }
  }
  if (!code.has(tailIndex) && cursorLine >= tailIndex && /^(?:Type (?:your )?(?:answer|response)|Enter (?:your )?(?:answer|response)|请输入(?:你的)?(?:回答|答案)|输入(?:你的)?(?:回答|答案))/i.test(hint)) {
    for (let i = tailIndex - 1; i >= Math.max(0, tailIndex - 20); i--) {
      if (!code.has(i) && (/[?？]\s*$/.test(lines[i]) || questionStart.test(lines[i]))) {
        const text = lines.slice(i, tailIndex).join('\n').trim();
        return { question: { id: JSON.stringify(['text', text, hint]), kind: 'text', text, choices: [] }, start: i, end: lines.length };
      }
    }
  }
  if (!code.has(tailIndex) && cursorLine >= tailIndex && /(?:space.*(?:select|toggle)|空格.*(?:选择|切换))/i.test(hint) && /enter|回车/i.test(hint)) {
    const options: { label: string; checked: boolean; selected: boolean; line: number }[] = [];
    let first = tailIndex;
    for (let i = Math.max(0, tailIndex - 25); i < tailIndex; i++) {
      const match = /^\s{0,3}([›❯>])?\s*(?:\[([ xX✓])\]|([☐☑]))\s+(.+)$/.exec(lines[i]);
      if (match && !code.has(i)) { options.push({ label: match[4], checked: match[2] !== undefined ? match[2] !== ' ' : match[3] === '☑', selected: Boolean(match[1]), line: i }); first = Math.min(first, i); }
    }
    let questionLine = first - 1;
    while (questionLine >= 0 && !lines[questionLine].trim()) questionLine--;
    const cursor = options.findIndex(option => option.selected);
    const onlyOptions = lines.slice(first, tailIndex).every((line, index) => !line.trim() || options.some(option => option.line === first + index));
    if (options.length >= 2 && options.length <= 9 && cursor >= 0 && options.filter(option => option.selected).length === 1 && onlyOptions && questionLine >= 0 && !code.has(questionLine) && (/[?？:]\s*$/.test(lines[questionLine]) || /^(?:select|choose|请选择)/i.test(lines[questionLine].trim()))) {
      const text = lines[questionLine].trim();
      const choices = options.map(option => ({ label: option.label, checked: option.checked, input: '' }));
      return { question: { id: JSON.stringify(['multi', text, choices, cursor]), kind: 'multi', text, choices, cursor }, start: questionLine, end: lines.length };
    }
  }
  const menu = findArrowMenu(lines, cursorLine, code, tailIndex);
  if (menu) return menu;
  for (let i = Math.max(0, lines.length - 35); i < lines.length; i++) {
    if (!code.has(i) && questionStart.test(lines[i])) start = i;
  }
  if (start >= 0) {
    const options: { label: string; selected: boolean; index: number; number: number }[] = [];
    let invalid = false;
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      const match = /^\s*([›❯>])?\s*([1-9])[.)]\s+(.+)$/.exec(lines[i]);
      if (match && !code.has(i)) {
        options.push({ label: match[3].trim(), selected: Boolean(match[1]), index: i, number: Number(match[2]) });
        end = i;
      } else if (options.length && lines[i].trim()) {
        if (/^\s{3,}\S/.test(lines[i]) && !/\b(?:enter|esc|arrow)\b|↑|↓|选择|确认|取消/i.test(lines[i])) {
          options[options.length - 1].label += `\n${lines[i].trim()}`;
          end = i;
        } else if (!/^(?:\s*)(?:(?:press\s+)?enter\b|esc\b|use (?:the )?arrow|↑|↓|按|使用.*(?:选择|方向键))/i.test(lines[i])) invalid = true;
      }
    }
    const selected = options.findIndex(option => option.selected);
    const suffix = lines.slice(end + 1).filter(line => line.trim());
    const onlyHintsAfter = suffix.every(line => /(?:enter|esc|arrow|↑|↓|选择|确认|取消)/i.test(line));
    if (!invalid && options.every((option, index) => option.number === index + 1) && options.length >= 2 && options.length <= 9 && selected >= 0 && options.filter(option => option.selected).length === 1 && onlyHintsAfter && cursorLine >= start) {
      const text = lines.slice(start, options[0].index).join('\n').trim();
      const choices = options.map((option, index) => ({ label: option.label, input: `${(index < selected ? '\x1b[A' : '\x1b[B').repeat(Math.abs(index - selected))}\r` }));
      return { question: { id: JSON.stringify([text, options.map(option => option.label), selected]), text, choices, cursor: selected }, start, end: lines.length };
    }
    const last = lines.slice(start).filter(line => line.trim()).at(-1) || '';
    if (/\((?:y\/n|Y\/n|y\/N)\)|\[(?:y\/n|Y\/n|y\/N)\]/.test(last) && cursorLine >= start) {
      const text = lines.slice(start).join('\n').trim();
      return { question: { id: text, text, choices: [{ label: '是', input: 'y\r' }, { label: '否', input: 'n\r' }] }, start, end: lines.length };
    }
  }
  let lastIndex = lines.length - 1;
  while (lastIndex >= 0 && !lines[lastIndex].trim()) lastIndex--;
  const last = lines[lastIndex] || '';
  const hasMenu = lines.slice(Math.max(0, lastIndex - 35), lastIndex).some(line => menuMarker.test(line));
  if (!hasMenu && !code.has(lastIndex) && /^(?:press (?:enter|return) to (?:continue|confirm)|按(?:下)?(?:回车|Enter)(?:键)?(?:继续|确认))/i.test(last.trim()) && cursorLine >= lastIndex) {
    const text = lines.slice(Math.max(0, lastIndex - 8)).join('\n').trim();
    return { question: { id: text, text, choices: [{ label: '继续', input: '\r' }] }, start: Math.max(0, lastIndex - 8), end: lines.length };
  }
  return null;
}

export function multiChoiceInput(question: ConversationQuestion, selected: number[]) {
  if (question.kind !== 'multi' || question.cursor === undefined || selected.some(index => !Number.isInteger(index) || index < 0 || index >= question.choices.length)) throw new Error('INVALID_SELECTION');
  let cursor = question.cursor, input = '';
  question.choices.forEach((choice, index) => {
    if (Boolean(choice.checked) === selected.includes(index)) return;
    input += (index < cursor ? '\x1b[A' : '\x1b[B').repeat(Math.abs(index - cursor)) + ' ';
    cursor = index;
  });
  return input + '\r';
}

export function projectConversation(lines: string[], cursorLine = lines.length - 1, toolName?: string | null, richLines = lines, renderedCode: ReadonlySet<number> = new Set()): ConversationProjection {
  // Preserve code indentation, Markdown tables and literal box characters.
  // VT already removed the terminal control sequences; stripping borders here
  // can silently change source code and command output.
  const cleaned = lines.map(line => line.trimEnd());
  const code = codeLines(cleaned);
  const terminalChrome = toolName === 'claude' ? claudeChrome(cleaned, code) : null;
  const interaction = findQuestion(cleaned, cursorLine, toolName, renderedCode);
  if (toolName === 'codex') {
    const end = interaction?.start ?? cleaned.length;
    return { ...projectCodex(cleaned.slice(0, end), richLines.slice(0, end), cursorLine, renderedCode), question: interaction?.question ?? null };
  }
  const events: ConversationEvent[] = [];
  let paragraph: string[] = [], paragraphKind: 'assistant' | 'user' = 'assistant';
  const flush = () => {
    const text = paragraph.join('\n').replace(/^\n+|\n+$/g, '').trimEnd(); paragraph = [];
    if (text.trim()) events.push({ id: `output-${events.length}`, kind: paragraphKind, text, ...(toolName === 'claude' ? { terminal: true } : {}) });
    paragraphKind = 'assistant';
  };
  for (let i = 0; i < cleaned.length; i++) {
    if (interaction && i >= interaction.start && i < interaction.end) { flush(); break; }
    if (terminalChrome?.hidden.has(i)) { flush(); continue; }
    const line = cleaned[i], trimmed = line.trim();
    if (code.has(i)) { paragraph.push(line); continue; }
    if (!trimmed) { if (toolName === 'claude' && paragraphKind === 'assistant' && paragraph.length) paragraph.push(''); else flush(); continue; }
    if (chrome.test(trimmed)) { flush(); continue; }
    const user = /^[›❯]\s+(.+)$/.exec(trimmed);
    if (user) { flush(); paragraphKind = 'user'; paragraph.push(user[1]); continue; }
    // Claude's native spinner also contains `·` and ASCII `*`. If either
    // escapes this classifier it becomes prose/a Markdown bullet for one
    // frame, replacing the activity row and restarting its CSS animation.
    // These ambiguous glyphs require Claude's trailing progress ellipsis;
    // ordinary lists, multiplication and code must retain their formatting.
    const progress = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✽✢✶✳]\s*(.+)$/.exec(trimmed)
      || (toolName === 'claude' ? /^[·*]\s+(.+?(?:…|\.{3})(?:\s*\([^\n]*\))?)$/.exec(trimmed) : null);
    const completion = /^([✓✔✗✘])\s+(.+)$/.exec(trimmed);
    const tool = /^[●•]\s+((?:(?:Bash|Read|Write|Edit|Glob|Grep|Search|Update|Execute|Run)\b|读取|写入|执行|搜索).*)/i.exec(trimmed);
    if (progress || completion || tool) {
      flush();
      events.push({ id: `output-${events.length}`, kind: 'activity', text: (progress?.[1] || completion?.[2] || tool?.[1] || '').replace(/\s*\((?:esc|ctrl\+c) to interrupt.*\)\s*$/i, ''), status: completion ? /[✗✘]/.test(completion[1]) ? 'failed' : 'done' : 'running' });
    } else if (/^(?:error\b|failed\b|错误[:：]|失败[:：])/i.test(trimmed)) {
      flush(); events.push({ id: `output-${events.length}`, kind: 'error', text: trimmed, status: 'failed' });
    } else {
      if (toolName === 'claude' && /^●\s+/.test(line)) flush();
      const source = toolName === 'claude' ? richLines[i] || line : line;
      const text = source.replace(/^[●]\s+/, '').replace(/^\s*⎿\s?/, '');
      paragraph.push(toolName === 'claude' ? text.replace(/^(\s*)•\s+/, '$1- ') : text);
    }
  }
  flush();
  return { events, question: interaction?.question ?? null, ...(terminalChrome?.status ? { terminalStatus: terminalChrome.status } : {}) };
}

const normalize = (value: string) => value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
export type ConversationRow = { source: 'message'; message: ChatMessage; key?: string } | { source: 'projection'; event: ConversationEvent };

const markdownParser = unified().use(remarkParse).use(remarkGfm);
interface MarkdownNode { type: string; value?: string; url?: string; identifier?: string; alt?: string | null; children?: MarkdownNode[] }
function visibleMarkdown(value: string) {
  const tree = markdownParser.parse(value);
  const definitions = new Map(tree.children.flatMap(node => node.type === 'definition' ? [[node.identifier, node.url] as const] : []));
  function read(node: MarkdownNode): string {
    // A soft wrap between CJK characters is layout, not a space in the
    // source. Do this only to prose nodes, never code or inline code.
    if (node.type === 'text') return (node.value || '').replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？、；：])[ \t]*\n[ \t]*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？、；：])/gu, '$1');
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return node.value || '';
    if (node.type === 'definition' || node.type === 'thematicBreak') return '';
    if (node.type === 'break') return '\n';
    if (node.type === 'image') return `${node.alt || ''} (${node.url || ''})`;
    const block = ['root', 'list', 'listItem', 'blockquote', 'table', 'tableRow'].includes(node.type);
    const content = (node.children || []).map(read).join(block ? '\n' : '');
    if (node.type === 'link' || node.type === 'linkReference') {
      const url = node.url || definitions.get(node.identifier || '');
      return url && url !== content ? `${content} (${url})` : content;
    }
    return content;
  }
  return normalize(read(tree));
}

const textCache = new WeakMap<ChatMessage, { content: string; normalized: string; visible?: string }>();
function messageText(message: ChatMessage, terminal: boolean) {
  let cached = textCache.get(message);
  if (!cached || cached.content !== message.content) {
    cached = { content: message.content, normalized: normalize(message.content) }; textCache.set(message, cached);
  }
  if (terminal) return cached.visible ??= visibleMarkdown(message.content);
  return cached.normalized;
}

/** Match fragments in reading order, consuming each occurrence once. Roles,
 * punctuation and case matter: a reply is not an echo of a user's prompt, and
 * `x += 1` must never replace `x = 1`. Unmatched output stays at its observed
 * position between the authoritative messages instead of moving to the tail. */
export function mergeConversationTimeline(projection: ConversationProjection, native: ChatMessage[], keys?: Map<string, string>): ConversationRow[] {
  const normalized = native.map(message => messageText(message, false));
  const visible = projection.events.some(event => event.terminal) ? native.map(message => messageText(message, true)) : normalized;
  const offsets = new Map<number, number>();
  const outputOffsets = new Map<number, number>();
  const before = new Map<number, ConversationEvent[]>();
  const liveTools = new Map<number, ChatMessage>();
  const waiting: ConversationEvent[] = [];
  let cursor = 0, anchor = -1;
  function insert(index: number) {
    before.set(index, [...(before.get(index) || []), ...waiting.splice(0)]);
  }
  for (const event of projection.events) {
    const text = event.terminal ? visibleMarkdown(event.text) : normalize(event.text);
    if (!text) continue;
    let match = -1, consumed = 0;
    for (let i = cursor; i < native.length; i++) {
      const message = native[i], offset = offsets.get(i) || 0, content = event.terminal ? visible[i] : normalized[i];
      if (event.kind === message.role && (event.kind === 'user' || event.kind === 'assistant')) {
        const position = content.indexOf(text, offset);
        const wholeLine = message.content.split('\n').some(line => normalize(line) === text);
        if (position >= 0 && (content === text || (event.kind === 'assistant' && (text.length >= 8 || wholeLine)))) {
          match = i; consumed = position + text.length; break;
        }
      }
      if (event.kind === 'assistant' && message.role === 'tool' && message.output) {
        const output = normalize(message.output), position = output.indexOf(text, outputOffsets.get(i) || 0);
        if (position >= 0 && (output === text || text.length >= 8)) {
          match = i; consumed = -1; outputOffsets.set(i, position + text.length); break;
        }
      }
      const tool = /^(\w+)\((.+)\)$/.exec(event.text);
      if (event.terminal && event.kind === 'activity' && message.role === 'tool' && !offset && codexToolMatches(event.text, message)) {
        // The call often reaches JSONL before its output does. Folding the VT
        // card into that empty native call must not hide the live tool output.
        const body = event.text.split('\n').slice(1).map(line => line.replace(/^\s*[└│]\s?/, '')).join('\n').trim();
        if (body && (!message.output || message.toolStatus === 'running')) liveTools.set(i, { ...message, output: body, ...(message.toolStatus === 'running' && event.status === 'failed' ? { toolStatus: 'failed' } : {}) });
        match = i; consumed = content.length || 1; break;
      }
      if (event.kind === 'activity' && tool && message.role === 'tool' && !offset && message.toolName?.toLowerCase() === tool[1].toLowerCase() && content.includes(normalize(tool[2]))) {
        match = i; consumed = content.length || 1; break;
      }
    }
    if (match < 0) waiting.push(event);
    else {
      insert(match); cursor = match; anchor = match;
      if (event.terminal && !keys?.has(native[match].id)) keys?.set(native[match].id, event.id);
      if (consumed >= 0) offsets.set(match, consumed);
    }
  }
  insert(anchor < 0 ? native.length : anchor + 1);
  const rows: ConversationRow[] = [];
  for (let i = 0; i <= native.length; i++) {
    for (const event of before.get(i) || []) rows.push({ source: 'projection', event });
    if (i < native.length) rows.push({ source: 'message', message: liveTools.get(i) || native[i], ...(keys?.has(native[i].id) ? { key: keys.get(native[i].id) } : {}) });
  }
  return rows;
}

export function supplementalEvents(projection: ConversationProjection, native: ChatMessage[], pending: string[] = []) {
  const remaining = [...pending];
  const events = projection.events.filter(event => {
    const index = event.kind === 'user' ? remaining.findIndex(text => normalize(text) === normalize(event.text)) : -1;
    if (index < 0) return true;
    remaining.splice(index, 1); return false;
  });
  return mergeConversationTimeline({ ...projection, events }, native)
    .flatMap(row => row.source === 'projection' ? [row.event] : []);
}
