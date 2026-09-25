import { expect, it } from 'vitest';
import { updateChatTranscript } from './chat-transcript';

// Wire shapes from protocol/{items,models,protocol}.rs and ext/items/*.rs.
const row = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';
const completed = (item: unknown) => row('event_msg', { type: 'item_completed', item });
const png = 'data:image/png;base64,iVBORw0KGgo=';

it('keeps image-only user turns, pairs their mirrors and does not expose binary data', () => {
  const legacy = row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: png }] });
  const modern = completed({ type: 'UserMessage', id: 'image-user', content: [{ type: 'image', image_url: png }] });
  const parsed = updateChatTranscript(legacy + modern);
  expect(parsed.messages).toHaveLength(1);
  expect(parsed.messages[0]).toMatchObject({ role: 'user', content: '', attachments: [{ kind: 'image', src: png }] });
});

it('keeps local image and audio references without treating local paths as phone URLs', () => {
  const parsed = updateChatTranscript(completed({ type: 'UserMessage', id: 'media', content: [{ type: 'text', text: 'Check these' }, { type: 'local_image', path: 'C:/work/a.png' }, { type: 'audio', audio_url: 'https://example.com/clip.wav' }] }));
  expect(parsed.messages).toHaveLength(1);
  expect(parsed.messages[0].content).toContain('Check these');
  expect(parsed.messages[0].attachments).toEqual([{ kind: 'image', label: '图片：C:/work/a.png' }, { kind: 'audio', label: '音频', url: 'https://example.com/clip.wav' }]);
});

it('converts MCP text, images, binary resources and error flags in legacy and paginated records', () => {
  const result = { content: [{ type: 'text', text: 'network timeout' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'resource', resource: { uri: 'file:///secret.bin', blob: 'BINARY_BYTES' } }], isError: true };
  const legacy = row('event_msg', { type: 'mcp_tool_call_end', call_id: 'mcp', invocation: { server: 'search', tool: 'find_docs', arguments: { query: 'ratatui' } }, result: { Ok: result } });
  const parsed = updateChatTranscript(legacy + completed({ type: 'McpToolCall', id: 'mcp', server: 'search', tool: 'find_docs', arguments: { query: 'ratatui' }, status: 'completed', result }));
  expect(parsed.messages).toHaveLength(1);
  expect(parsed.messages[0]).toMatchObject({ toolStatus: 'failed', output: 'network timeout' });
  expect(parsed.messages[0].attachments).toHaveLength(2);
  expect(parsed.messages[0].output).not.toContain('BINARY_BYTES');
  const serialized = updateChatTranscript(row('response_item', { type: 'function_call_output', call_id: 'serialized', output: JSON.stringify(result) }));
  expect(serialized.messages[0].output).toBe('network timeout');
  expect(serialized.messages[0].attachments?.[0].src).toBe(png);
});

it('handles all dynamic tool failure channels and camelCase content fields', () => {
  const parsed = updateChatTranscript(completed({ type: 'DynamicToolCall', id: 'dynamic', namespace: 'workspace', tool: 'inspect', arguments: {}, status: 'completed', success: false, content_items: [{ type: 'inputText', text: 'Permission denied' }, { type: 'inputImage', imageUrl: png }] }));
  expect(parsed.messages[0]).toMatchObject({ toolName: 'workspace.inspect', toolStatus: 'failed', output: 'Permission denied', attachments: [{ src: png }] });
  const failed = updateChatTranscript(completed({ type: 'DynamicToolCall', id: 'dynamic2', tool: 'inspect', status: 'failed', error: 'Unavailable' }));
  expect(failed.messages[0].output).toBe('Unavailable');
});

it('does not mark a still-running command complete when its initial item ends', () => {
  const initial = updateChatTranscript(row('response_item', { type: 'local_shell_call', call_id: 'shell', status: 'in_progress', action: { type: 'exec', command: ['npm', 'test'], working_directory: '/workspace', env: { PRIVATE: 'hidden' } } }));
  expect(initial.messages[0].toolStatus).toBe('running');
  expect(initial.messages[0].content).not.toContain('PRIVATE');
  const next = updateChatTranscript(completed({ type: 'CommandExecution', id: 'shell', command: ['npm', 'test'], status: 'completed', exit_code: 2, aggregated_output: 'tests failed' }), initial);
  expect(next.messages).toHaveLength(1);
  expect(next.messages[0]).toMatchObject({ toolStatus: 'failed', output: 'tests failed' });
  expect(initial.messages[0].toolStatus).toBe('running');
});

it('retains web actions and full search results across the three durable representations', () => {
  const action = { type: 'open_page', url: 'https://example.com/docs' };
  const native = row('response_item', { type: 'web_search_call', id: 'web', status: 'completed', action });
  const legacy = row('event_msg', { type: 'web_search_end', call_id: 'web', query: '', action, results: [{ title: 'Documentation', url: action.url }] });
  const extension = completed({ type: 'Extension', id: 'web', kind: 'web.search', query: '', action: { ...action, type: 'openPage' }, results: [{ title: 'Documentation', url: action.url }] });
  const parsed = updateChatTranscript(native + legacy + extension);
  expect(parsed.messages).toHaveLength(1);
  expect(parsed.messages[0]).toMatchObject({ toolName: 'web_search', toolStatus: 'done' });
  expect(parsed.messages[0].content).toContain(action.url);
  expect(parsed.messages[0].output).toContain('Documentation');
});

it('retains original apply_patch input while adding structured file changes from completion', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';
  const raw = row('response_item', { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: patch });
  const changes = { 'src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new', move_path: 'src/b.ts' } };
  const parsed = updateChatTranscript(raw + row('event_msg', { type: 'patch_apply_end', call_id: 'patch', success: false, status: 'declined', changes, stderr: 'User declined' }));
  expect(parsed.messages).toHaveLength(1);
  expect(parsed.messages[0]).toMatchObject({ content: patch, changes, toolStatus: 'failed', output: 'User declined' });
});

it.each(['ImageGeneration', 'Extension'])('renders %s media without base64 text, including extension usage-limit failures', type => {
  const parsed = updateChatTranscript(completed({ type, kind: 'image_gen.generation', id: 'image', status: 'completed', result: 'iVBORw0KGgo=', savedPath: '/work/image.png', revisedPrompt: 'A blue square' }));
  expect(parsed.messages[0]).toMatchObject({ toolName: 'image_generation', attachments: [{ kind: 'image', src: png }] });
  expect(parsed.messages[0].output).not.toContain('iVBOR');
  const failed = updateChatTranscript(completed({ type: 'Extension', kind: 'image_gen.generation', id: 'limit', status: 'failed', result: '', failure: { type: 'usageLimitExceeded', limitId: 'images' } }));
  expect(failed.messages[0].toolStatus).toBe('failed');
  expect(failed.messages[0].output).toContain('usageLimitExceeded');
});

it('keeps review findings with file locations, sub-agent activity, compaction and interrupted turns', () => {
  const raw = completed({ type: 'CollabAgentToolCall', id: 'spawn', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['child'], prompt: 'Review tests', agents_states: { child: 'running' } }) +
    completed({ type: 'SubAgentActivity', id: 'activity', agent_path: '/root/test', kind: 'interrupted' }) +
    completed({ type: 'EnteredReviewMode', id: 'review-in', user_facing_hint: 'Review current changes' }) +
    row('event_msg', { type: 'entered_review_mode', item_id: 'review-in', user_facing_hint: 'Review current changes' }) +
    completed({ type: 'ExitedReviewMode', id: 'review-out', review_output: { overall_correctness: 'patch is incorrect', overall_explanation: 'One issue', findings: [{ title: '[P1] Preserve output', body: 'Do not drop results', code_location: { absolute_file_path: '/work/main.ts', line_range: { start: 10, end: 12 } } }] } }) +
    completed({ type: 'ContextCompaction', id: 'compact' }) +
    completed({ type: 'Extension', kind: 'clock.sleep', id: 'sleep', durationMs: 250 }) +
    completed({ type: 'ImageView', id: 'view', path: '/work/a.png' }) +
    row('event_msg', { type: 'turn_aborted', reason: 'interrupted' });
  const messages = updateChatTranscript(raw).messages;
  expect(messages).toHaveLength(8);
  expect(messages.find(m => m.id === 'review-out')?.output).toContain('/work/main.ts:10–12');
  expect(messages.find(m => m.id === 'activity')?.output).toBe('子任务已中断');
  expect(messages.find(m => m.id === 'sleep')?.output).toBe('等待了 0.25 秒');
  expect(messages.at(-1)?.output).toBe('本轮已中断');
});

it('filters internal hooks, agent-to-agent envelopes and encrypted compaction data', () => {
  const raw = completed({ type: 'HookPrompt', id: 'hook', fragments: [{ text: 'internal hook instruction' }] }) + row('response_item', { type: 'compaction', encrypted_content: 'SECRET_BYTES' }) + row('response_item', { type: 'configuration_update', reasoning: {} }) + row('response_item', { type: 'agent_message', author: 'worker', recipient: 'parent', content: [{ type: 'input_text', text: 'internal task' }] });
  expect(updateChatTranscript(raw).messages).toEqual([]);
});

it('does not create active HTML or huge media URLs from tool resources', () => {
  const output = [{ type: 'image', image_url: 'data:image/svg+xml;base64,PHN2Zz4=' }, { type: 'image', image_url: 'javascript:alert(1)' }, { type: 'resource', resource: { uri: 'secret.bin', blob: 'PRIVATE_BINARY' } }];
  const parsed = updateChatTranscript(row('response_item', { type: 'function_call_output', call_id: 'resources', output }));
  expect(parsed.messages[0].output).toBe('');
  expect(parsed.messages[0].attachments).toHaveLength(3);
  expect(parsed.messages[0].attachments?.every(a => !a.src && !a.url)).toBe(true);
});
