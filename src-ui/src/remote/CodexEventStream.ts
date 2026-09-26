import { updateChatTranscript, type ChatMessage } from '../lib/chat-transcript';
import { codexStatus, object, type CodexStatus } from '../lib/codex-rollout';
import type { ActivityPhase } from './types';

type Row = Record<string, unknown>;
export interface CodexPage { epoch: string; cursor: number; reset: boolean; online: boolean; complete: boolean; has_more?: boolean; thread_id: string | null; events: { sequence: number; message: Row }[] }
export interface CodexLive { available: boolean; retained?: boolean; threadId?: string; messages: ChatMessage[]; status?: CodexStatus; activity?: ActivityPhase }
const snake = (value: unknown) => String(value || '').replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

/** App-server v2 ThreadItem is camelCase and differs from rollout TurnItem. */
function itemMessages(raw: Row): ChatMessage[] {
  const type = String(raw.type || '');
  const item: Row = { ...raw, type: type.charAt(0).toUpperCase() + type.slice(1), status: snake(raw.status) };
  for (const [key, value] of Object.entries(raw)) if (/[A-Z]/.test(key)) item[snake(key)] = value;
  if (type === 'agentMessage') item.content = [{ type: 'Text', text: raw.text }];
  if (type === 'userMessage' && Array.isArray(raw.content)) item.content = raw.content.filter(object).map(block => ({ ...block, type: snake(block.type) }));
  if (type === 'reasoning') item.summary_text = raw.summary;
  if (type === 'enteredReviewMode') item.user_facing_hint = raw.review;
  if (type === 'exitedReviewMode') item.review_output = { overall_explanation: raw.review };
  if (type === 'collabAgentToolCall') item.tool = snake(raw.tool);
  if (type === 'fileChange' && Array.isArray(raw.changes)) item.changes = Object.fromEntries(raw.changes.filter(object).map(change => [String(change.path), {
    type: object(change.kind) ? snake(change.kind.type) : 'update',
    unified_diff: change.diff, move_path: object(change.kind) ? change.kind.move_path ?? change.kind.movePath : undefined,
  }]));
  if (type === 'sleep') { item.type = 'Extension'; item.kind = 'clock.sleep'; item.durationMs = raw.durationMs; }
  const messages = updateChatTranscript(JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } })).messages;
  return messages.map(message => message.role === 'reasoning' ? { ...message, toolStatus: raw.status === 'inProgress' ? 'running' : 'done' } : message);
}

/** Ordered, idempotent v2 event reducer. Completed items replace streamed
 * text (Codex explicitly allows plan completion to differ from its deltas). */
export class CodexEventStream {
  private epoch = '';
  private cursor = 0;
  private items = new Map<string, Row>();
  private messages = new Map<string, ChatMessage[]>();
  private status?: CodexStatus;
  private activity?: ActivityPhase;
  private complete = false;
  private threadId?: string;
  private snapshot?: CodexLive;
  apply(page: CodexPage): CodexLive {
    if (!page.reset && page.epoch === this.epoch && !page.events.length && this.snapshot && this.snapshot.available === (page.online && page.complete && this.complete && !page.has_more && Boolean(this.threadId))) return this.snapshot;
    if (page.epoch !== this.epoch || page.reset) {
      this.epoch = page.epoch; this.cursor = 0; this.items.clear(); this.messages.clear();
      this.status = undefined; this.activity = undefined; this.threadId = page.thread_id || undefined; this.complete = page.complete;
    }
    const dirty = new Set<string>();
    const put = (item: Row) => {
      if (typeof item.id !== 'string' || item.type === 'hookPrompt') return;
      this.items.set(item.id, item); dirty.add(item.id);
      if (!this.messages.has(item.id)) this.messages.set(item.id, []);
    };
    for (const event of page.events) {
      if (event.sequence <= this.cursor) continue;
      if (event.sequence !== this.cursor + 1) this.complete = false;
      this.cursor = event.sequence;
      const { method, params } = event.message;
      if (!object(params) || (params.threadId && params.threadId !== page.thread_id)) continue;
      if (method === 'sinos/thread') {
        this.threadId = String(params.threadId);
        this.status = codexStatus({ type: 'turn_context', payload: params }, this.status);
        this.activity = threadActivity(params.status);
      } else if (method === 'thread/status/changed') {
        this.activity = threadActivity(params.status);
      } else if (method === 'thread/settings/updated' && object(params.threadSettings)) {
        this.status = codexStatus({ type: 'turn_context', payload: params.threadSettings }, this.status);
      } else if (method === 'thread/tokenUsage/updated' && object(params.tokenUsage)) {
        const usage = params.tokenUsage;
        this.status = codexStatus({ type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: usage.modelContextWindow, last_token_usage: { total_tokens: object(usage.last) ? usage.last.totalTokens : undefined } } } }, this.status);
      } else if (method === 'turn/started' || method === 'turn/completed') {
        this.activity = method === 'turn/started' ? 'working' : object(params.turn) && params.turn.status === 'completed' ? 'idle' : 'failed';
        if (object(params.turn) && Array.isArray(params.turn.items)) for (const item of params.turn.items) if (object(item)) put(item);
      } else if (method === 'item/started' || method === 'item/completed') {
        if (object(params.item)) {
          // File/command completion can omit an output already streamed.
          const old = this.items.get(String(params.item.id));
          put({ ...old, ...params.item, status: params.item.status || (method === 'item/started' ? 'inProgress' : 'completed'), ...(params.item.aggregatedOutput == null && old?.aggregatedOutput ? { aggregatedOutput: old.aggregatedOutput } : {}) });
        }
      } else if (typeof method === 'string' && /\/(?:delta|outputDelta|summaryTextDelta|summaryPartAdded)$/.test(method)) {
        const id = String(params.itemId || ''); if (!id) continue;
        const fallback = method === 'item/agentMessage/delta' ? 'agentMessage' : method === 'item/plan/delta' ? 'plan' : method.startsWith('item/reasoning/') ? 'reasoning' : method.startsWith('item/commandExecution/') ? 'commandExecution' : 'fileChange';
        const item = { ...(this.items.get(id) || { id, type: fallback, status: 'inProgress' }) };
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (fallback === 'reasoning') {
          const index = Number(params.summaryIndex); if (!Number.isSafeInteger(index) || index < 0 || index > 1000) continue;
          const summary = Array.isArray(item.summary) ? [...item.summary] : [];
          summary[index] = String(summary[index] || '') + delta; item.summary = summary;
        } else {
          const field = fallback === 'commandExecution' ? 'aggregatedOutput' : fallback === 'fileChange' ? 'stdout' : 'text';
          item[field] = String(item[field] || '') + delta;
        }
        put(item);
      } else if (method === 'item/fileChange/patchUpdated') {
        const id = String(params.itemId || '');
        if (id) put({ ...this.items.get(id), id, type: 'fileChange', changes: params.changes, status: 'inProgress' });
      } else if (method === 'turn/plan/updated') {
        const id = `plan-${params.turnId}`;
        const plan = Array.isArray(params.plan) ? params.plan.filter(object).map(step => ({ step: step.step, status: snake(step.status) })) : [];
        this.messages.set(id, [{ id, role: 'tool', toolName: 'update_plan', toolStatus: 'done', content: JSON.stringify({ explanation: params.explanation, plan }) }]);
      } else if (method === 'item/mcpToolCall/progress') {
        const id = String(params.itemId || ''); const old = this.items.get(id);
        if (old && typeof params.message === 'string') put({ ...old, result: { content: [{ type: 'text', text: params.message }] } });
      } else if (method === 'error') {
        const text = object(params.error) ? String(params.error.message || '') : String(params.message || 'Codex 执行出错');
        const id = `error-${event.sequence}`;
        this.messages.set(id, [{ id, role: 'tool', toolName: params.willRetry ? '正在重试' : '执行错误', toolStatus: params.willRetry ? 'running' : 'failed', content: '', output: text }]);
        if (!params.willRetry) this.activity = 'failed';
      } else if (typeof method === 'string' && /\/(?:requestApproval|requestUserInput)$/.test(method)) this.activity = 'waiting';
      else if (method === 'serverRequest/resolved') this.activity = 'working';
      else if (method === 'thread/reverted') { this.items.clear(); this.messages.clear(); dirty.clear(); this.complete = false; }
    }
    for (const id of dirty) {
      const item = this.items.get(id); if (item) this.messages.set(id, itemMessages(item));
    }
    this.snapshot = { available: page.online && page.complete && this.complete && !page.has_more && Boolean(this.threadId), threadId: this.threadId,
      messages: [...this.messages.values()].flat(), status: this.status, activity: this.activity };
    return this.snapshot;
  }
}

function threadActivity(status: unknown): ActivityPhase {
  if (!object(status)) return 'unknown';
  if (status.type === 'idle') return 'idle';
  if (status.type === 'systemError') return 'failed';
  if (status.type !== 'active') return 'unknown';
  return Array.isArray(status.activeFlags) && status.activeFlags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'waiting' : 'working';
}

/** Preserve native history and replace matching current items with the live
 * authoritative Markdown, retaining the live ID across the disk handoff. */
export function mergeCodexMessages(native: ChatMessage[], live: ChatMessage[], samePrompt = (a: string, b: string) => a === b): ChatMessage[] {
  const result: ChatMessage[] = []; let anchor = 0;
  let pending: ChatMessage[] = [];
  for (const message of live) {
    let index = native.findIndex((item, i) => i >= anchor && item.id === message.id);
    if (index < 0 && message.content.trim()) {
      const matches = native.flatMap((item, i) => i >= anchor && item.role === message.role && item.toolName === message.toolName && (message.role === 'user' ? samePrompt(item.content, message.content) : item.content === message.content) ? [i] : []);
      if (matches.length === 1) index = matches[0];
    }
    // Disk can flush a final response before its last websocket page arrives.
    // Restrict prefix reconciliation to the already matched user turn.
    if (index < 0 && anchor > 0 && message.role === 'assistant' && message.content.length >= 12) {
      const end = native.findIndex((item, i) => i >= anchor && item.role === 'user');
      const matches = native.flatMap((item, i) => i >= anchor && (end < 0 || i < end) && item.role === 'assistant' && item.content.startsWith(message.content) ? [i] : []);
      if (matches.length === 1) index = matches[0];
    }
    if (index >= 0) { result.push(...native.slice(anchor, index), ...pending, message); pending = []; anchor = index + 1; }
    else pending.push(message);
  }
  return [...result, ...native.slice(anchor), ...pending];
}
