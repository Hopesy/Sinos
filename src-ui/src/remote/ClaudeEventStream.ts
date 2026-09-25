import type { ChatMessage } from '../lib/chat-transcript';
import { normalizePrompt } from '../lib/chat-transcript';
import type { CodexPage } from './CodexEventStream';
import type { ActivityPhase } from './types';
import type { TerminalStatus } from './claudeChrome';

export interface ClaudeTurn { id: string; prompt: string; messages: ChatMessage[]; complete: boolean }
export interface ClaudeLive {
  available: boolean; retained?: boolean; threadId?: string; turns: ClaudeTurn[];
  status?: TerminalStatus; cwd?: string; activity?: ActivityPhase;
}
export class ClaudeEventStream {
  private epoch = ''; private cursor = 0; private valid = true;
  private turns: ClaudeTurn[] = [];
  private blocks = new Map<string, ChatMessage>();
  private status: TerminalStatus | undefined;
  private cwd: string | undefined;
  private activity: ActivityPhase = 'unknown';
  private snapshot: ClaudeLive = { available: false, turns: [] };
  apply(page: CodexPage): ClaudeLive {
    if (!page || !Array.isArray(page.events)) return this.snapshot;
    if (!page.reset && page.epoch === this.epoch && page.cursor === this.cursor && !page.events.length &&
        this.snapshot.available === (page.online && page.complete && this.valid && !page.has_more && this.turns.length > 0)) return this.snapshot;
    if (page.epoch !== this.epoch || (page.reset && page.cursor < this.cursor)) {
      this.epoch = page.epoch; this.cursor = 0; this.valid = true;
      this.turns = []; this.blocks.clear(); this.status = undefined; this.cwd = undefined; this.activity = 'unknown';
    }
    for (const { sequence, message: event } of page.events) {
      if (sequence <= this.cursor) continue;
      if (sequence !== this.cursor + 1) this.valid = false;
      this.cursor = sequence;
      if (event.kind === 'session') {
        this.status = { model: typeof event.model === 'string' ? event.model : this.status?.model, lines: this.status?.lines || [] };
        if (typeof event.cwd === 'string') this.cwd = event.cwd;
        if (typeof event.percent === 'number') this.status.lines = [`上下文已用 ${Math.round(event.percent)}%`];
        continue;
      }
      const id = typeof event.turn === 'string' ? event.turn : '';
      if (event.kind === 'start' && id) {
        if (!this.turns.some(turn => turn.id === id)) this.turns.push({ id, prompt: String(event.text || ''), messages: [], complete: false });
        this.activity = 'working';
        continue;
      }
      const turn = this.turns.find(turn => turn.id === id);
      if (!turn) { this.valid = false; continue; }
      if (typeof event.model === 'string') this.status = { ...this.status, model: event.model, lines: this.status?.lines || [] };
      const key = `${id}:${event.step}:${event.index}`;
      if (event.kind === 'text') {
        let message = this.blocks.get(key);
        if (!message) { message = { id: `claude-${key}`, role: 'assistant', content: '' }; turn.messages.push(message); this.blocks.set(key, message); }
        message.content += typeof event.text === 'string' ? event.text : '';
      } else if (event.kind === 'tool') {
        const message: ChatMessage = { id: String(event.id), role: 'tool', toolName: String(event.name), content: '', toolStatus: 'running' };
        this.blocks.set(key, message); turn.messages.push(message);
      } else if (event.kind === 'input') {
        const message = this.blocks.get(key);
        if (message?.role === 'tool') message.content += typeof event.text === 'string' ? event.text : '';
        else this.valid = false;
      } else if (event.kind === 'step') {
        for (const [block, message] of this.blocks) if (block.startsWith(`${id}:${event.step}:`) && message.role === 'tool') {
          try { message.content = JSON.stringify(JSON.parse(message.content || '{}'), null, 2); } catch { /* Partial/aborted tool arguments remain visible. */ }
        }
      } else if (event.kind === 'result') {
        const message = turn.messages.find(message => message.role === 'tool' && message.id === event.id);
        if (message) { message.output = String(event.text || ''); message.toolStatus = event.failed ? 'failed' : 'done'; }
      } else if (event.kind === 'complete') {
        turn.complete = true;
        this.activity = event.reason === 'error' || event.reason === 'refusal' ? 'failed' : 'idle';
        for (const message of turn.messages) if (message.toolStatus === 'running') message.toolStatus = 'failed';
        if (event.reason === 'error' || event.reason === 'refusal' || event.reason === 'aborted') turn.messages.push({ id: `claude-${id}-end`, role: 'tool', toolName: event.reason === 'aborted' ? '已停止' : '本轮未完成', content: '', toolStatus: event.reason === 'aborted' ? 'done' : 'failed' });
      }
    }
    // Snapshots must not share mutable messages with React's previous render.
    this.snapshot = { available: page.online && page.complete && this.valid && !page.has_more && this.turns.length > 0,
      threadId: page.thread_id || undefined, turns: this.turns.map(turn => ({ ...turn, messages: turn.messages.map(message => ({ ...message })) })),
      status: this.status, cwd: this.cwd, activity: this.activity };
    return this.snapshot;
  }
}

/** Anchor at user turns, working backwards so repeated prompts match the
 * current occurrence. Native tool outcomes/images supplement the live text;
 * raw Markdown remains authoritative through the disk-flush handoff. */
export function mergeClaudeMessages(native: ChatMessage[], live: ClaudeTurn[], known = new Map<string, string>()): ChatMessage[] {
  const anchors = new Map<string, number>();
  let end = native.length;
  for (let i = live.length - 1; i >= 0; i--) {
    const turn = live[i];
    let found = -1;
    const reserved = new Set([...known].filter(([id]) => id !== turn.id).map(([, id]) => id));
    for (let j = end - 1; j >= 0; j--) {
      if (native[j].role !== 'user' || reserved.has(native[j].id)) continue;
      if (known.has(turn.id) ? native[j].id !== known.get(turn.id) : native[j].id.split(':')[0] !== turn.id && (!turn.prompt.trim() || normalizePrompt(native[j].content) !== normalizePrompt(turn.prompt))) continue;
      // A repeated prompt still waiting for its disk row must not consume an
      // older completed answer. Once bound, the native UUID pins the handoff.
      if (!known.has(turn.id) && !turn.complete) {
        const tail = native.slice(j + 1); const boundary = tail.findIndex(m => m.role === 'user');
        const disk = boundary < 0 ? tail : tail.slice(0, boundary);
        const answer = disk.find(m => m.role === 'assistant');
        const partial = turn.messages.find(m => m.role === 'assistant');
        if (answer && (!partial || !answer.content.startsWith(partial.content))) continue;
      }
      found = j; break;
    }
    if (found >= 0) { anchors.set(turn.id, found); known.set(turn.id, native[found].id); end = found; }
  }
  const result: ChatMessage[] = []; let cursor = 0;
  for (const turn of live) {
    const anchor = anchors.get(turn.id);
    if (anchor !== undefined) {
      result.push(...native.slice(cursor, anchor));
      let tail = anchor + 1; while (tail < native.length && native[tail].role !== 'user') tail++;
      const disk = native.slice(anchor + 1, tail);
      result.push({ ...native[anchor], id: `claude-${turn.id}-user` });
      // Native reasoning and passive media are kept; text/tools come from the
      // stream. A complete disk response can arrive ahead of the last WS page.
      const messages = turn.messages.map(message => {
        const full = disk.find(item => item.id === message.id);
        return full && message.role === 'tool' ? { ...message, ...full, toolStatus: full.toolStatus === 'running' ? message.toolStatus : full.toolStatus, output: full.output || message.output } : message;
      });
      result.push(...disk.filter(message => message.role === 'reasoning'), ...messages);
      const media = disk.filter(message => message.attachments?.length);
      result.push(...media.map(message => ({ ...message, content: '', id: `${message.id}-media` })));
      // Before any assistant chunk, native may have just flushed the answer.
      if (!messages.length && turn.complete) result.push(...disk.filter(message => message.role !== 'reasoning' && !message.attachments?.length));
      cursor = tail;
    } else {
      // Persisted older history goes before unflushed live turns.
      result.push(...native.slice(cursor)); cursor = native.length;
      if (turn.prompt.trim()) result.push({ id: `claude-${turn.id}-user`, role: 'user', content: turn.prompt });
      result.push(...turn.messages);
    }
  }
  return [...result, ...native.slice(cursor)];
}
