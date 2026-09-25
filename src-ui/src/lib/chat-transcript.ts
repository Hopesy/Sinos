import { codexOtherItem, codexRowId, codexStatus, codexToolFailed, codexTurnItem, type CodexStatus } from './codex-rollout';
import { chatContent, type ChatAttachment } from './chat-content';

export type ChatRole = 'user' | 'assistant' | 'reasoning' | 'tool';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolName?: string;
  toolStatus?: 'running' | 'done' | 'failed';
  output?: string;
  codexOrigin?: number;
  attachments?: ChatAttachment[];
  changes?: Record<string, unknown>;
}

export interface ChatTranscriptState {
  messages: ChatMessage[];
  remainder: string;
  nextLineIndex: number;
  codexStatus?: CodexStatus;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const INJECTED_PREFIXES = [
  '<environment_context>', '<ide_opened_file>', '<ide_closed_file>',
  '<ide_selection>', '<system-reminder>', '<command-message>', '<command-name>',
  '# AGENTS.md', 'Run your Session Startup sequence',
  'Below is a conversation log from a Claude Code coding session',
];

// Claude records completed sub-agent reports as external `user` rows even
// though they are protocol notifications. Only treat the tag as structural at
// the beginning of a message so a real user can still discuss the tag itself.
const INJECTED_START_ONLY_PREFIXES = ['<task-notification>'];

export function normalizePrompt(text: string): string {
  return text
    .replace(/"\s+((?:[A-Za-z]:[\\/]|\/)[^"]+?\.(?:png|jpe?g|gif|webp|bmp))\s+"/gi, '$1')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function isInjected(text: string): boolean {
  const trimmed = text.trim();
  return INJECTED_PREFIXES.some(prefix => trimmed.startsWith(prefix) || trimmed.includes(prefix)) ||
    INJECTED_START_ONLY_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item) {
        return stringValue((item as { text: unknown }).text);
      }
      return stringValue(item);
    }).filter(Boolean).join('\n');
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function push(
  out: ChatMessage[], message: ChatMessage, previousCount: number, owned: Set<number>,
) {
  if (!message.content.trim() && !message.attachments?.length) return;
  const previousIndex = out.length - 1;
  let previous = out[previousIndex];
  if (previous && !previous.codexOrigin && previous.role === message.role && message.role !== 'tool' &&
      previous.id.split(':')[0] === message.id.split(':')[0]) {
    if (previousIndex < previousCount && !owned.has(previousIndex)) {
      previous = { ...previous };
      out[previousIndex] = previous;
      owned.add(previousIndex);
    }
    previous.content += `\n\n${message.content}`;
    if (message.attachments?.length) previous.attachments = [...(previous.attachments || []), ...message.attachments];
    return;
  }
  out.push(message);
}

function parseBlocks(
  out: ChatMessage[], blocks: unknown, role: 'user' | 'assistant', rowId: string,
  toolById: Map<string, number>, previousCount: number, owned: Set<number>,
) {
  const values = Array.isArray(blocks) ? blocks : [blocks];
  values.forEach((raw, index) => {
    if (typeof raw === 'string') {
      if (!isInjected(raw)) push(out, { id: `${rowId}:${index}`, role, content: raw }, previousCount, owned);
      return;
    }
    if (!raw || typeof raw !== 'object') return;
    const block = raw as JsonObject;
    const type = String(block.type ?? 'text');
    if (['text', 'input_text', 'output_text'].includes(type) || (!block.type && block.text)) {
      const text = stringValue(block.text ?? block.content);
      if (!isInjected(text)) push(out, { id: `${rowId}:${index}`, role, content: text }, previousCount, owned);
    } else if (/^(?:input_?image|image|local_image|input_?audio|audio|local_audio)$/i.test(type)) {
      const media = chatContent(block);
      push(out, { id: `${rowId}:${index}`, role, content: media.text, attachments: media.attachments }, previousCount, owned);
    } else if (type === 'thinking' || type === 'reasoning') {
      push(out, { id: `${rowId}:${index}`, role: 'reasoning', content: stringValue(block.thinking ?? block.text ?? block.summary) }, previousCount, owned);
    } else if (type === 'tool_use' || type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      // Codex emits both an item `id` and a `call_id`; its corresponding
      // function_call_output references call_id. Claude only has `id`, so
      // preferring call_id links both formats correctly. CodeBuddy camel-cases
      // the same field (`callId`) and pairs it with a `function_call_result`
      // row, which the result branch below links the same way.
      const id = String(block.call_id ?? block.callId ?? block.id ?? `${rowId}:${index}`);
      const message: ChatMessage = {
        id,
        role: 'tool',
        toolName: [typeof block.namespace === 'string' ? block.namespace : '', String(block.name ?? block.tool_name ?? (type === 'tool_search_call' ? 'tool_search' : 'Tool'))].filter(Boolean).join('.'),
        content: stringValue(block.input ?? block.arguments ?? block.command),
        toolStatus: 'running',
        ...(isObject(block.changes) ? { changes: block.changes } : {}),
      };
      const existing = toolById.get(id);
      if (existing === undefined) { out.push(message); toolById.set(id, out.length - 1); }
      else {
        const retain = block.preserve_input === true && out[existing].content;
        out[existing] = { ...out[existing], toolName: retain ? out[existing].toolName : message.toolName, content: retain ? out[existing].content : message.content, ...(message.changes ? { changes: message.changes } : {}) }; owned.add(existing);
      }
    } else if (type === 'tool_result' || type === 'function_call_output' || type === 'function_call_result' || type === 'custom_tool_call_output' || type === 'tool_search_output') {
      const id = String(block.tool_use_id ?? block.call_id ?? block.callId ?? block.id ?? '');
      const targetIndex = toolById.get(id);
      // `status` covers CodeBuddy's function_call_result rows, which flag a
      // failed tool with status "incomplete" and carry no is_error field.
      const failed = block.is_error === true || block.error != null ||
        block.status === 'incomplete' || block.status === 'failed' ||
        ((type === 'function_call_output' || type === 'custom_tool_call_output') && codexToolFailed(block.output));
      if (targetIndex !== undefined) {
        const status = failed ? 'failed' : block.status === 'in_progress' ? 'running' : 'done';
        const { text: output, attachments } = chatContent(block.content ?? block.output ?? block.tools ?? block.error);
        if (out[targetIndex].toolStatus !== status || out[targetIndex].output !== output || attachments.length || out[targetIndex].attachments?.length) {
          if (targetIndex < previousCount && !owned.has(targetIndex)) {
            out[targetIndex] = { ...out[targetIndex] };
            owned.add(targetIndex);
          }
          out[targetIndex].toolStatus = status;
          out[targetIndex].output = output;
          out[targetIndex].attachments = attachments.length ? attachments : undefined;
        }
      } else {
        // A paginated tail can begin with a result whose call is in an older
        // page. Keep it visible; reparsing after prepend joins it to the call.
        const resultId = id || `${rowId}:${index}`;
        const media = chatContent(block.content ?? block.output ?? block.tools ?? block.error);
        out.push({ id: resultId, role: 'tool', toolName: String(block.name ?? '工具结果'), content: '', output: media.text, ...(media.attachments.length ? { attachments: media.attachments } : {}), toolStatus: failed ? 'failed' : block.status === 'in_progress' ? 'running' : 'done' });
        toolById.set(resultId, out.length - 1);
      }
    }
  });
}

function parseLine(
  out: ChatMessage[], toolById: Map<string, number>, line: string, lineIndex: number,
  previousCount: number, owned: Set<number>,
) {
    if (!line.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (!isObject(parsed)) return;
    const root = parsed;
    const message = isObject(root.message) ? root.message : null;
    const payload = isObject(root.payload) ? root.payload : null;
    const rowId = String(root.uuid ?? root.id ?? message?.id ?? payload?.id ?? (root.type === 'response_item' || root.type === 'event_msg' ? codexRowId(line) : lineIndex));

    // Hermes legacy sessions are one JSON document rather than JSONL:
    // `{ session_id, messages: [{ role, content }, ...] }`. The history
    // scanner still surfaces these files, so normalize their root-level array
    // before entering the per-row protocol branches below.
    if (Array.isArray(root.messages)) {
      root.messages.forEach((rawMessage, index) => {
        if (!isObject(rawMessage)) return;
        if (rawMessage.role !== 'user' && rawMessage.role !== 'assistant') return;
        parseBlocks(
          out,
          rawMessage.content,
          rawMessage.role,
          `${rowId}:message-${index}`,
          toolById,
          previousCount,
          owned,
        );
      });
      return;
    }

    // Codex rollout rows place messages and tool calls under payload.
    if (payload) {
      if (root.type === 'event_msg' && payload.type === 'thread_rolled_back' && typeof payload.num_turns === 'number' && Number.isSafeInteger(payload.num_turns) && payload.num_turns > 0) {
        let turns = payload.num_turns, start = out.length;
        while (start > 0 && turns > 0) { start--; if (out[start].role === 'user') turns--; }
        out.splice(start);
        toolById.clear(); out.forEach((item, index) => { if (item.role === 'tool') toolById.set(item.id, index); });
        return;
      }
      const item = (root.type === 'event_msg' ? codexTurnItem(payload) : null) ?? codexOtherItem(root, rowId);
      const role = item?.role ?? payload.role;
      if (item || payload.type === 'reasoning' || (payload.type === 'message' && (role === 'user' || role === 'assistant'))) {
        const start = out.length;
        parseBlocks(out, item ? item.blocks : payload.type === 'reasoning' ? payload : payload.content, role === 'user' ? 'user' : 'assistant', item?.id ?? rowId, toolById, previousCount, owned);
        // Paginated rollouts persist both response_item and ItemCompleted.
        // Pair mirrors once; identical replies on subsequent turns stay intact.
        const origin = item ? 2 : 1;
        for (let i = start; i < out.length; i++) {
          const added = out[i];
          if (added.role === 'tool') continue;
          added.codexOrigin = origin;
          for (let j = start - 1; j >= 0; j--) {
            const candidate = out[j];
            if (candidate.role === 'user' && added.role !== 'user') break;
            if (candidate.role === added.role && candidate.content === added.content && JSON.stringify(candidate.attachments) === JSON.stringify(added.attachments) && candidate.codexOrigin && (candidate.id === added.id || !(candidate.codexOrigin & origin))) {
              out[j] = { ...candidate, codexOrigin: candidate.codexOrigin | origin }; owned.add(j);
              out.splice(i--, 1); break;
            }
            if (candidate.role === 'user' || candidate.role === 'assistant') break;
          }
        }
      } else if (['function_call', 'custom_tool_call', 'function_call_output', 'function_call_result', 'custom_tool_call_output', 'tool_search_call', 'tool_search_output', 'reasoning'].includes(String(payload.type))) {
        parseBlocks(out, payload, 'assistant', rowId, toolById, previousCount, owned);
      }
      return;
    }

    // Kimi Code's wire protocol records user messages under
    // context.append_message and streamed assistant parts as loop events.
    // The generic message branch below handles the former; normalize the
    // latter here before it falls through the root-role checks.
    if (root.type === 'context.append_loop_event' && isObject(root.event)) {
      const event = root.event;
      if (event.type === 'content.part' && isObject(event.part)) {
        const part = event.part;
        if (part.type === 'think') {
          push(out, { id: rowId, role: 'reasoning', content: stringValue(part.think) }, previousCount, owned);
        } else if (part.type === 'text') {
          push(out, { id: rowId, role: 'assistant', content: stringValue(part.text) }, previousCount, owned);
        }
      }
      return;
    }

    if (message && Array.isArray(message.parts)) {
      parseBlocks(out, message.parts, message.role === 'user' ? 'user' : 'assistant', rowId, toolById, previousCount, owned);
      return;
    }
    if (message?.role === 'user' || message?.role === 'assistant') {
      parseBlocks(out, message.content, message.role === 'user' ? 'user' : 'assistant', rowId, toolById, previousCount, owned);
      return;
    }

    // Antigravity/Gemini and several wire protocols use root-level roles.
    if (root.type === 'reasoning') {
      push(out, { id: rowId, role: 'reasoning', content: stringValue(root.summary ?? root.content) }, previousCount, owned);
      return;
    }
    const rootRole = root.role ?? root.type;
    if (rootRole === 'user' || rootRole === 'assistant' || rootRole === 'gemini') {
      if (rootRole === 'user' && root.synthetic_reason) return;
      const role = rootRole === 'user' ? 'user' : 'assistant';
      const data = isObject(root.data) ? root.data : null;
      parseBlocks(out, root.content ?? root.parts ?? root.text ?? data?.content, role, rowId, toolById, previousCount, owned);
    }
}

/** Parse an initial transcript or append a byte-aligned JSONL tail. Keeping
 * parser state means a long live session never needs to be reparsed merely
 * because one more row was appended; tool results can still update tool calls
 * that arrived in an earlier chunk. */
export function updateChatTranscript(
  raw: string,
  previous?: ChatTranscriptState,
): ChatTranscriptState {
  // The array itself is copied so React sees an append, but settled message
  // objects retain their identity. Only a merged live tail or a tool whose
  // status changed is cloned on write; long sessions therefore avoid an O(n)
  // object allocation burst on every streamed chunk.
  const out = previous ? [...previous.messages] : [];
  const previousCount = out.length;
  const owned = new Set<number>();
  const toolById = new Map<string, number>();
  out.forEach((message, index) => {
    if (message.role === 'tool') toolById.set(message.id, index);
  });

  const combined = `${previous?.remainder ?? ''}${raw}`;
  const lines = combined.split(/\r?\n/);
  let remainder = '';
  if (lines.length > 0 && !combined.endsWith('\n')) {
    const trailing = lines.pop() ?? '';
    // Most writers flush a complete JSON object before its newline. Parse a
    // valid trailing row immediately; retain only genuinely partial JSON.
    try {
      JSON.parse(trailing);
      lines.push(trailing);
    } catch {
      remainder = trailing;
    }
  }

  let nextLineIndex = previous?.nextLineIndex ?? 0;
  let status = previous?.codexStatus;
  lines.forEach(line => {
    try { const row: unknown = JSON.parse(line); if (isObject(row)) status = codexStatus(row, status); } catch { /* Partial rows stay in remainder. */ }
    parseLine(out, toolById, line, nextLineIndex, previousCount, owned);
    nextLineIndex += 1;
  });

  return { messages: out, remainder, nextLineIndex, ...(status ? { codexStatus: status } : {}) };
}

export function transcriptHasPrompt(messages: ChatMessage[], prompt: string): boolean {
  const target = normalizePrompt(prompt);
  return !!target && messages.some(message =>
    message.role === 'user' && normalizePrompt(message.content) === target
  );
}
