import type { ConversationEvent, ConversationProjection } from './conversationProjection';
import type { TerminalStatus } from './claudeChrome';
import type { ChatMessage } from '../lib/chat-transcript';

// Only consume a live tool card when its arguments identify the native call.
// The bare word "Called" / a truncated title is not enough to merge two tools.
export function codexToolMatches(text: string, message: ChatMessage): boolean {
  const canonical = (name: string) => name.replace(/^mcp__/, '').replace(/__/g, '.').replace(/[/.]/g, '.').toLowerCase();
  const name = canonical(message.toolName || '');
  const normalized = (v: string) => v.replace(/\s+/g, ' ').trim();
  const stable = (v: unknown): string => JSON.stringify(v, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  const called = /^(?:Called|Calling|Failed|Interrupted)\s+(?:└\s*)?([\w./-]+)\(([\s\S]*?)\)(?:\s*·[^\n]*)?(?:\n|$)/.exec(text);
  if (called && canonical(called[1]) === name) {
    try { return stable(JSON.parse(called[2])) === stable(JSON.parse(message.content)); } catch { return false; }
  }
  let args: Record<string, unknown>;
  try { args = JSON.parse(message.content) as Record<string, unknown>; if (!args || typeof args !== 'object') return false; } catch { return false; }
  const heading = text.split('\n')[0];
  const command = /^(?:Ran|Running) (.+)$/.exec(heading)?.[1];
  if (command && /(?:^|\.)(?:exec_command|shell|bash)$/.test(name)) {
    const actual = args.cmd ?? args.command;
    return typeof actual === 'string' && normalized(command) === normalized(actual);
  }
  if (name === 'web_search') {
    const query = args.query || (Array.isArray(args.queries) ? args.queries.join(', ') : '');
    const expected = args.type === 'open_page' || args.type === 'openPage' ? `Opened ${args.url}` : args.type === 'find_in_page' || args.type === 'findInPage' ? `Searched for '${args.pattern}'${args.url ? ` in ${args.url}` : ''}` : query ? `Searched the web for ${query}` : '';
    return Boolean(expected && normalized(heading) === normalized(expected));
  }
  return false;
}

// Codex history_cell/messages.rs prefixes assistant cells with “• ” and
// continuation rows with two spaces. markdown_render.rs also uses “• ” for
// list items. The gutter is not a Markdown list item or a tool invocation.
export function projectCodex(lines: string[], rich: string[], cursor: number, renderedCode: ReadonlySet<number>): ConversationProjection {
  const hidden = new Set<number>();
  let status: TerminalStatus | undefined;
  let header = false;
  lines.forEach((line, i) => {
    if (/^[╭│].*OpenAI Codex\b/.test(line) || /^│\s*>_ OpenAI Codex\b/.test(line)) header = true;
    if (header || (/^[╭╰][─━]+[╮╯]$/.test(line.trim()) && /OpenAI Codex/.test(lines[i + 1] || ''))) {
      hidden.add(i);
      const model = /^│\s*model:\s*(.*?)\s*(?:\/model.*)?│?\s*$/i.exec(line)?.[1];
      if (model) status = { ...status, model: model.replace(/\s+│$/, ''), lines: status?.lines || [] };
      const cwd = /^│\s*directory:\s*(.*?)\s*│?\s*$/i.exec(line)?.[1];
      if (cwd) status = { ...status, cwd, lines: status?.lines || [] };
      if (/^╰[─━]+╯/.test(line.trim())) header = false;
    }
  });
  // Footer hints replace the status line while typing/working. Extract only
  // the composer area, never a quoted model/context example in the answer.
  const lastContent = lines.findLastIndex(line => line.trim());
  for (let i = lastContent; i >= Math.max(0, lastContent - 12); i--) {
    if (!/^›(?:\s|$)/.test(lines[i])) continue;
    if (/^›\s+[1-9][.)]\s/.test(lines[i])) continue;
    const tail = lines.slice(i + 1).filter(line => line.trim());
    const footer = tail.every(line => /^\s{2,}/.test(line) && /^(?:context.*\d+%|\d+%.*context|\? for shortcuts|esc to|tab to|gpt-|o[134](?:\b|[-.])|codex|shift\+|ctrl\+)| · /i.test(line.trim()));
    // Startup draws the placeholder before its footer/cursor-position frame.
    // It is input chrome, including while the model is still loading.
    const placeholder = /^›\s*Ask Codex to do anything\s*$/i.test(lines[i]);
    if (!footer || (!placeholder && cursor < i) || (!tail.length && cursor !== i && !placeholder)) continue;
    for (let j = i; j < lines.length; j++) hidden.add(j);
    const text = tail.find(line => /(?:context.*\d+%|\d+%.*context|gpt-|codex| · )/i.test(line))?.trim();
    if (text) {
      const parts = text.split(/\s+·\s+/);
      const model = /^(?:gpt-|o[134](?:\b|[-.])|codex)/i.test(parts[0]) ? parts.shift() : undefined;
      status = { ...status, model: model || status?.model, lines: parts.filter(part => !/\? for shortcuts|esc to|tab to/i.test(part)) };
    }
    break;
  }
  const events: ConversationEvent[] = [];
  let content: string[] = [], kind: ConversationEvent['kind'] = 'assistant', start = 0, code = false;
  let activityStatus: 'running' | 'done' | 'failed' = 'done';
  let notice: 'info' | 'warning' | undefined;
  let inMessage = false;
  const fence = '`'.repeat(Math.max(3, ...lines.map(line => Math.max(0, ...[...line.matchAll(/`+/g)].map(match => match[0].length + 1)))));
  const flush = () => {
    if (code) { while (content.at(-1) === '') content.pop(); content.push(fence); code = false; }
    const text = restoreTables(content).join('\n').trimEnd().replace(/^\n+/, '');
    if (text.trim()) events.push({ id: `codex-${start}`, kind, text, terminal: true, ...(['activity', 'error'].includes(kind) ? { status: activityStatus, ...(notice ? { notice } : {}) } : {}) });
    content = [];
    notice = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hidden.has(i)) { flush(); continue; }
    // Dim startup hints are colored text, not syntax-highlighted source code.
    if (!inMessage && /^\s*Tip:\s/.test(line)) { flush(); continue; }
    if (renderedCode.has(i) && (kind === 'assistant' || /^• /.test(line))) {
      if (/^• /.test(line)) { flush(); start = i; kind = 'assistant'; }
      if (!code) { content.push('', fence); code = true; }
      content.push(line.replace(/^(?:• | {2})/, ''));
      continue;
    }
    if (code && !line.trim()) { content.push(''); continue; }
    if (code) { content.push(fence, ''); code = false; }
    if (/^\s*[─━]{8,}\s*$/.test(line)) { flush(); continue; }
    const user = /^›\s+(.+)$/.exec(line);
    const assistant = /^•\s(.*)$/.exec(line);
    // Commands are identified by the actual Codex lifecycle verbs, rather
    // than “Read/Run” at the start of arbitrary answer prose.
    const tool = /^• (Ran |Running |Explored\b|Updated Plan\b|Edited |Added |Deleted |Called\b|Calling\b|Failed\b|Interrupted\b|Searched (?:the )?web\b|Searching the web\b|Opened |Opening |Searched (?:for |page\b)|Viewed image\b|Viewing image\b|Generated image\b|Generating image\b|Context compacted\b|Spawned |Sent input to |Waiting for |Finished waiting\b|Resuming |Resumed |Closed |Agent spawn failed\b|(?:Started|Completed|Interacted with) `\/)(.*)/.exec(line);
    const review = /^>> Code review (?:started: .+|finished) <<$/.test(line);
    const working = /^[•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(.+?)\s*\((?:[^()\n]*[·•]\s*)?esc to interrupt.*\)$/i.exec(line.trim());
    const notification = /^(■|⚠|ⓘ|✔|✗)\s+(.+)/.exec(line);
    if (notification) {
      flush(); start = i; kind = notification[1] === '■' ? 'error' : 'activity';
      activityStatus = /[■✗]/.test(notification[1]) ? 'failed' : 'done';
      notice = notification[1] === '⚠' ? 'warning' : notification[1] === 'ⓘ' ? 'info' : undefined;
      content.push(notification[2]); continue;
    }
    if (working || tool || review) {
      flush(); start = i; kind = 'activity';
      activityStatus = /^• (Failed|Interrupted|Agent spawn failed)\b/.test(line) ? 'failed' : working || /^• (Running|Calling|Searching|Opening|Viewing|Generating|Waiting for|Resuming)\b/.test(line) ? 'running' : 'done';
      content.push(working?.[1] || (review ? line.slice(3, -3) : line.slice(2)));
      continue;
    }
    if (/^• Worked for\b|^─+ Worked for\b/.test(line) || (!inMessage && /^\s*(?:Tip:|\? for shortcuts|\d+% context left)/i.test(line))) { flush(); continue; }
    if (user || assistant) { flush(); start = i; kind = user ? 'user' : 'assistant'; inMessage = true; }
    if (!content.length && !user && !assistant) start = i;
    const source = kind === 'activity' || kind === 'error' ? line : rich[i] || line;
    let text = user ? user[1] : assistant ? source.slice(2) : source.replace(/^ {2}/, '');
    if (kind === 'activity' && /^\s*(?:└\s*)?(?:Error:|Process exited with code [1-9]|Exit code: [1-9])/.test(text)) activityStatus = 'failed';
    if (kind === 'assistant') text = text.replace(/^(\s*)•\s+/, '$1- ');
    content.push(text);
  }
  flush();
  return { events, question: null, ...(status ? { terminalStatus: status } : {}) };
}

function restoreTables(lines: string[]): string[] {
  const result = [...lines];
  let fenced = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^`{3,}/.test(lines[i - 1])) fenced = !fenced;
    if (fenced || !/^[━─]+(?: {2,}[━─]+)+$/.test(lines[i])) continue;
    const columns = lines[i].split(/ {2,}/).length;
    const cells = (line: string) => line.trim().replace(/^\*\*([\s\S]*)\*\*$/, '$1').split(/ {2,}/).map(cell => cell.replace(/\|/g, '\\|'));
    if (cells(lines[i - 1]).length !== columns) continue;
    result[i - 1] = `| ${cells(lines[i - 1]).join(' | ')} |`;
    result[i] = `| ${Array<string>(columns).fill('---').join(' | ')} |`;
    for (let j = i + 1; j < lines.length && lines[j].trim(); j++) {
      const row = cells(lines[j]);
      if (row.length !== columns) break;
      result[j] = `| ${row.join(' | ')} |`;
    }
  }
  return result;
}
