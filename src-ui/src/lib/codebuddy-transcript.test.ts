import { expect, it } from 'vitest';
import { updateChatTranscript } from './chat-transcript';

const row = (payload: object) => `${JSON.stringify({ type: 'response_item', payload })}\n`;
it.each(['completed', 'incomplete', 'failed'])('links CodeBuddy %s results to calls across streamed chunks', status => {
  const initial = updateChatTranscript(row({ type: 'function_call', callId: 'call-1', id: 'item-1', name: 'read_file', arguments: '{"path":"app.ts"}' }));
  const text = row({ type: 'function_call_result', callId: 'call-1', output: 'file contents', status });
  const partial = updateChatTranscript(text.slice(0, 30), initial);
  const final = updateChatTranscript(text.slice(30), partial);
  expect(initial.messages[0].toolStatus).toBe('running');
  expect(final.messages).toEqual([{ id: 'call-1', role: 'tool', toolName: 'read_file', content: '{"path":"app.ts"}', output: 'file contents', toolStatus: status === 'completed' ? 'done' : 'failed' }]);
});
