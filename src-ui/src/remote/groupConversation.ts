import type { ChatMessage } from '../lib/chat-transcript';
import type { ConversationRow } from './conversationProjection';

export type DisplayRow = ConversationRow | { source: 'tools'; id: string; messages: ChatMessage[] };

/** Only adjacent native tool records belong together. Never cross a reply,
 * a question, reasoning, or a projected event, and keep each original record. */
export function groupConversation(rows: ConversationRow[]): DisplayRow[] {
  const grouped: DisplayRow[] = [];
  for (const row of rows) {
    if (row.source === 'message' && row.message.role === 'tool') {
      const previous = grouped.at(-1);
      if (previous?.source === 'tools') previous.messages.push(row.message);
      else grouped.push({ source: 'tools', id: `native-${row.message.id}`, messages: [row.message] });
    } else grouped.push(row);
  }
  return grouped;
}
