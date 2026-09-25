import { expect, it } from 'vitest';
import { updateChatTranscript } from './chat-transcript';

const row = (type: string, payload: unknown, timestamp = '2026-09-25T08:00:00.123Z') => JSON.stringify({ timestamp, type, payload }) + '\n';
const response = (text: string, role = 'assistant', id?: string) => row('response_item', { type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
const completed = (item: unknown) => row('event_msg', { type: 'item_completed', turn_id: 'turn', item });

it('uses IDs stable across history prepend and arbitrary JSONL byte chunks', () => {
  const older = response('Earlier', 'user'), recent = response('Newer', 'assistant');
  const initial = updateChatTranscript(recent);
  expect(updateChatTranscript(older + recent).messages[1].id).toBe(initial.messages[0].id);
  let streamed = updateChatTranscript('');
  for (let i = 0; i < recent.length; i += 7) streamed = updateChatTranscript(recent.slice(i, i + 7), streamed);
  expect(streamed.messages).toEqual(initial.messages);
});

it('pairs response/TurnItem mirrors without removing identical replies in later turns', () => {
  const mirror = completed({ type: 'AgentMessage', id: 'msg', content: [{ type: 'Text', text: 'Done' }] });
  const initial = updateChatTranscript(response('Done', 'assistant', 'msg'));
  const paired = updateChatTranscript(mirror, initial);
  expect(paired.messages).toHaveLength(1);
  expect(paired.messages[0].content).toBe('Done');
  expect(initial.messages[0].codexOrigin).toBe(1);
  const next = updateChatTranscript(response('Again', 'user') + response('Done', 'assistant', 'another'), paired);
  expect(next.messages.map(message => message.content)).toEqual(['Done', 'Again', 'Done']);
});

it('pairs mirrors without response IDs and supports paginated-only user messages and reasoning', () => {
  const raw = response('Hello') + completed({ type: 'AgentMessage', id: 'generated', content: [{ type: 'Text', text: 'Hello' }] }) + completed({ type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'Continue' }] }) + completed({ type: 'Reasoning', id: 'r', summary_text: ['Checking the files'], raw_content: ['private reasoning'] });
  expect(updateChatTranscript(raw).messages.map(message => [message.role, message.content])).toEqual([['assistant', 'Hello'], ['user', 'Continue'], ['reasoning', 'Checking the files']]);
});

it('joins paginated command completion with its call and keeps failures visible', () => {
  const initial = updateChatTranscript(row('response_item', { type: 'function_call', call_id: 'call', name: 'exec_command', arguments: '{"cmd":"npm test"}' }));
  const result = updateChatTranscript(completed({ type: 'CommandExecution', id: 'call', command: ['npm', 'test'], cwd: '/project', status: 'failed', aggregated_output: '1 test failed', exit_code: 1 }), initial);
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toMatchObject({ id: 'call', toolStatus: 'failed', output: '1 test failed' });
  expect(result.messages[0].content).toBe(initial.messages[0].content);
  expect(initial.messages[0].toolStatus).toBe('running');
});

it('tracks native model/context across appends without emitting HUD or internal agent messages', () => {
  const meta = row('turn_context', { model: 'gpt-5.4', effort: 'xhigh', cwd: '/workspace' });
  const tokens = row('event_msg', { type: 'token_count', info: { model_context_window: 112000, last_token_usage: { total_tokens: 32000 }, total_token_usage: { total_tokens: 5000000 } } });
  const state = updateChatTranscript(meta + tokens);
  expect(state.codexStatus).toEqual({ model: 'gpt-5.4', effort: 'xhigh', cwd: '/workspace', contextRemaining: 80 });
  const next = updateChatTranscript(response('Ready') + row('response_item', { type: 'agent_message', author: 'worker', recipient: 'parent', content: [{ type: 'input_text', text: 'internal' }] }), state);
  expect(next.codexStatus).toEqual(state.codexStatus);
  expect(next.messages.map(message => message.content)).toEqual(['Ready']);
});

it('applies rollback without mutating the previous snapshot or retaining removed tools', () => {
  const initial = updateChatTranscript(response('First', 'user') + response('One') + response('Second', 'user') + row('response_item', { type: 'function_call', call_id: 'removed', name: 'exec_command', arguments: '{}' }) + response('Two'));
  const next = updateChatTranscript(row('event_msg', { type: 'thread_rolled_back', num_turns: 1 }), initial);
  expect(next.messages.map(message => message.content)).toEqual(['First', 'One']);
  expect(initial.messages).toHaveLength(5);
});

it('updates model changes immediately from thread_settings_applied', () => {
  const initial = updateChatTranscript(row('turn_context', { model: 'gpt-5.4', effort: 'xhigh', cwd: '/old' }));
  const next = updateChatTranscript(row('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5', reasoning_effort: 'high', cwd: '/new' } }), initial);
  expect(next.codexStatus).toEqual({ model: 'gpt-5.5', effort: 'high', cwd: '/new' });
});

it('recognizes failed native command result envelopes and keeps tool-search results', () => {
  const data = row('response_item', { type: 'function_call_output', call_id: 'failed', output: JSON.stringify({ output: 'test failed', metadata: { exit_code: 1 } }) }) + row('response_item', { type: 'tool_search_call', call_id: 'search', arguments: { query: 'files' } }) + row('response_item', { type: 'tool_search_output', call_id: 'search', status: 'completed', tools: [{ name: 'read_file' }] });
  const parsed = updateChatTranscript(data);
  expect(parsed.messages[0].toolStatus).toBe('failed');
  expect(parsed.messages[1]).toMatchObject({ toolName: 'tool_search', toolStatus: 'done' });
  expect(parsed.messages[1].output).toContain('read_file');
});

it('pairs reasoning summaries across the two persisted representations', () => {
  const native = row('response_item', { type: 'reasoning', id: 'reason', summary: [{ type: 'summary_text', text: 'Checking' }] });
  const item = completed({ type: 'Reasoning', id: 'reason', summary_text: ['Checking'] });
  expect(updateChatTranscript(native + item).messages).toHaveLength(1);
});
