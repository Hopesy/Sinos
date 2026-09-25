type Row = Record<string, unknown>;
export const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
export interface CodexStatus { model?: string; effort?: string; cwd?: string; contextRemaining?: number }

export function codexStatus(root: Row, previous?: CodexStatus): CodexStatus | undefined {
  if (!object(root.payload)) return previous;
  const p = root.payload;
  if (root.type === 'event_msg' && p.type === 'thread_settings_applied' && object(p.thread_settings)) {
    return codexStatus({ type: 'turn_context', payload: { ...p.thread_settings, effort: p.thread_settings.reasoning_effort } }, previous);
  }
  if (root.type === 'turn_context') return { ...previous,
    ...(typeof p.model === 'string' ? { model: p.model } : {}),
    effort: typeof p.effort === 'string' ? p.effort : undefined,
    ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
  };
  if (root.type === 'session_meta' && typeof p.cwd === 'string') return { ...previous, cwd: p.cwd };
  if (root.type === 'event_msg' && p.type === 'token_count' && object(p.info)) {
    const info = p.info, usage = info.last_token_usage;
    if (object(usage) && typeof usage.total_tokens === 'number' && typeof info.model_context_window === 'number' && info.model_context_window > 0) {
      // protocol.rs TokenUsage::percent_of_context_window_remaining. Use the
      // last context usage, never cumulative billing tokens across turns.
      const window = info.model_context_window - 12000;
      const contextRemaining = window <= 0 ? 0 : Math.round(Math.max(0, Math.min(1, (window - Math.max(0, usage.total_tokens - 12000)) / window)) * 100);
      return { ...previous, contextRemaining };
    }
  }
  return previous;
}

/** Normalize completed TurnItems from paginated Codex rollouts. Live deltas
 * aren't persisted; CodexEventStream supplies them, with VT as a fallback. */
export function codexTurnItem(payload: Row): { id: string; role: 'user' | 'assistant'; blocks: unknown } | null {
  if (payload.type !== 'item_completed' || !object(payload.item)) return null;
  const item = payload.item;
  if (typeof item.id !== 'string') return null;
  const id = item.id;
  const textContent = (content: unknown) => Array.isArray(content) ? content.filter(object).map(block =>
    block.type === 'Text' ? { ...block, type: 'text' } : block) : [];
  if (item.type === 'AgentMessage' || item.type === 'UserMessage') return { id, role: item.type === 'UserMessage' ? 'user' : 'assistant', blocks: textContent(item.content) };
  if (item.type === 'Plan') return { id, role: 'assistant', blocks: [{ type: 'text', text: item.text }] };
  if (item.type === 'Reasoning') return { id, role: 'assistant', blocks: [{ type: 'reasoning', summary: item.summary_text }] };
  if (item.type === 'FunctionCallOutput') return { id, role: 'assistant', blocks: { type: 'function_call_output', call_id: id, name: item.name, output: item.output } };
  const failed = ['failed', 'declined', 'interrupted', 'incomplete'].includes(String(item.status)) || item.success === false || item.failure != null || (typeof item.exit_code === 'number' && item.exit_code !== 0) || item.error != null || codexToolFailed(item.result);
  let name: string, input: unknown, output: unknown;
  switch (item.type) {
    case 'CommandExecution': name = 'exec_command'; input = { cmd: Array.isArray(item.command) ? item.command.join(' ') : item.command, cwd: item.cwd }; output = item.aggregated_output ?? item.formatted_output ?? [item.stdout, item.stderr].filter(Boolean).join('\n'); break;
    case 'FileChange': name = 'apply_patch'; input = { changes: item.changes }; output = [item.stdout, item.stderr].filter(Boolean).join('\n'); break;
    case 'McpToolCall': name = `${item.server}/${item.tool}`; input = item.arguments; output = item.result ?? item.error; break;
    case 'DynamicToolCall': name = [item.namespace, item.tool ?? 'Tool'].filter(Boolean).join('.'); input = item.arguments; output = item.error ?? item.content_items; break;
    case 'WebSearch': name = 'web_search'; input = { query: item.query, ...(object(item.action) ? item.action : {}) }; output = item.results; break;
    case 'ImageView': name = 'view_image'; input = { path: item.path }; output = '已查看图片'; break;
    case 'ImageGeneration': name = 'image_generation'; input = { prompt: item.revised_prompt ?? item.revisedPrompt, path: item.saved_path ?? item.savedPath }; output = item.failure ?? (typeof item.result === 'string' && item.result ? [{ type: 'image', image_url: item.result.startsWith('data:') ? item.result : `data:image/png;base64,${item.result}` }] : item.status); break;
    case 'CollabAgentToolCall': name = String(item.tool); input = { prompt: item.prompt, agents: item.receiver_agents, thread_ids: item.receiver_thread_ids, model: item.model }; output = item.agents_states; break;
    case 'SubAgentActivity': name = 'sub_agent'; input = { path: item.agent_path }; output = ({ started: '子任务已启动', interacted: '子任务已收到消息', interrupted: '子任务已中断', completed: '子任务已完成' } as Row)[String(item.kind)] ?? item.kind; break;
    case 'EnteredReviewMode': name = 'review'; input = { target: item.target }; output = item.user_facing_hint || '已进入代码审查'; break;
    case 'ExitedReviewMode': name = 'review'; input = {}; output = reviewText(item.review_output); break;
    case 'ContextCompaction': name = 'context_compaction'; input = {}; output = '上下文已压缩'; break;
    case 'Extension': {
      if (item.kind === 'web.search' || item.kind === 'image_gen.generation') return codexTurnItem({ ...payload, item: { ...item, type: item.kind === 'web.search' ? 'WebSearch' : 'ImageGeneration' } });
      if (item.kind !== 'clock.sleep') return null;
      name = 'sleep'; input = { duration_ms: item.durationMs }; output = `等待了 ${Number(item.durationMs || 0) / 1000} 秒`; break;
    }
    // HookPrompt is an internal model instruction, not a user-visible reply.
    default: return null;
  }
  return { id, role: 'assistant', blocks: [
    { type: 'function_call', call_id: id, name, arguments: input, preserve_input: true, changes: item.type === 'FileChange' ? item.changes : undefined },
    { type: 'function_call_output', call_id: id, output, is_error: failed, status: ['in_progress', 'inProgress'].includes(String(item.status)) ? 'in_progress' : undefined },
  ] };
}

function reviewText(output: unknown): string {
  if (!object(output)) return '代码审查已结束';
  const findings = Array.isArray(output.findings) ? output.findings.filter(object).map(f => {
    const location = object(f.code_location) ? f.code_location : {};
    const range = object(location.line_range) ? location.line_range : {};
    return [f.title, location.absolute_file_path ? `${location.absolute_file_path}:${range.start ?? ''}${range.end ? `–${range.end}` : ''}` : '', f.body].filter(Boolean).join('\n');
  }) : [];
  return [output.overall_correctness, output.overall_explanation, ...findings].filter(Boolean).join('\n\n') || '代码审查已结束';
}

/** Legacy rollouts persist ResponseItems and selected end events instead of TurnItems. */
export function codexOtherItem(root: Row, fallbackId: string): ReturnType<typeof codexTurnItem> {
  if (!object(root.payload)) return null;
  const p = root.payload, id = String(p.call_id ?? p.item_id ?? p.event_id ?? p.id ?? fallbackId);
  const convert = (type: string, fields: Row = p) => codexTurnItem({ type: 'item_completed', item: { ...fields, id, type } });
  if (root.type === 'response_item') {
    if (p.type === 'web_search_call') return convert('WebSearch');
    if (p.type === 'image_generation_call') return convert('ImageGeneration');
    if (p.type === 'local_shell_call' && object(p.action)) return convert('CommandExecution', { ...p.action, cwd: p.action.working_directory, status: p.status });
  }
  if (root.type !== 'event_msg') return null;
  if (p.type === 'web_search_end') return convert('WebSearch');
  if (p.type === 'image_generation_end') return convert('ImageGeneration');
  if (p.type === 'patch_apply_end') return convert('FileChange', { ...p, status: p.success === false ? 'failed' : p.status });
  if (p.type === 'mcp_tool_call_end' && object(p.invocation)) {
    const result = object(p.result) && 'Ok' in p.result ? p.result.Ok : p.result;
    const error = object(p.result) ? p.result.Err : undefined;
    return convert('McpToolCall', { ...p.invocation, result: error ? undefined : result, error });
  }
  if (p.type === 'sub_agent_activity') return convert('SubAgentActivity');
  if (p.type === 'entered_review_mode') return convert('EnteredReviewMode', object(p.review_request) ? p.review_request : p);
  if (p.type === 'exited_review_mode') return convert('ExitedReviewMode');
  if (p.type === 'context_compacted') return convert('ContextCompaction');
  if (p.type === 'turn_aborted') return { id, role: 'assistant', blocks: [
    { type: 'function_call', call_id: id, name: 'turn_aborted', arguments: {} },
    { type: 'function_call_output', call_id: id, output: p.reason === 'interrupted' ? '本轮已中断' : `本轮已结束：${String(p.reason || '已中断')}` },
  ] };
  return null;
}

// Timestamp/ordinal + row content remains stable when older pages are prepended.
// Line numbers do not. Two hashes also avoid collisions in large rollouts.
export function codexRowId(line: string): string {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b, 33) ^ c; }
  return `codex-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}

export function codexToolFailed(output: unknown): boolean {
  if (typeof output === 'string') {
    try { return codexToolFailed(JSON.parse(output)); } catch { /* Older tool output envelopes are plain text. */ }
    const exit = /^(?:Exit code:\s*|Chunk ID:[^\n]*\n(?:[^\n]*\n){0,4}Process exited with code\s+)(-?\d+)\b/.exec(output);
    return Boolean(exit && Number(exit[1]) !== 0);
  }
  return object(output) && (output.isError === true || output.is_error === true || (object(output.metadata) && typeof output.metadata.exit_code === 'number' && output.metadata.exit_code !== 0));
}
