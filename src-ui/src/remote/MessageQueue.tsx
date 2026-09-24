import { useState } from 'react';
import { ArrowUp, Check, ChevronDown, ListPlus, Pencil, X } from 'lucide-react';
import type { QueuedPrompt } from './types';

export function MessageQueue({ messages, disabled, canSend, held, onAction }: {
  messages: QueuedPrompt[]; disabled: boolean; canSend: boolean; held: boolean;
  onAction: (action: 'edit' | 'remove' | 'send' | 'hold' | 'release', item: QueuedPrompt, text?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  if (!messages.length) return null;
  return <details className="message-queue"><summary><ListPlus size={16} /><span>待发送 · {messages.length}</span><small>{held ? '自动发送已暂停' : canSend ? '可选择现在发送' : '等待本轮结束'}</small><ChevronDown size={14} /></summary>
    <div className="queue-items">{messages.map(item => <div className="queue-item" key={item.id}>
      {editing === item.id ? <><textarea aria-label="编辑排队消息" rows={3} value={text} onChange={e => setText(e.target.value)} /><div className="queue-actions"><button disabled={disabled || (!text.trim() && !item.attachments?.length)} onClick={() => void onAction('edit', item, text).then(() => setEditing(null)).catch(() => {})}><Check size={14} />保存</button><button disabled={disabled} onClick={() => void onAction('release', item).then(() => setEditing(null)).catch(() => {})}>取消</button></div></> : <><p>{item.text || (item.attachments?.length ? '图片消息' : '')}</p>{Boolean(item.attachments?.length) && <small className="queue-image-names">{item.attachments!.length} 张图片 · {item.attachments!.map(image => image.name).join('、')}</small>}{item.status === 'editing' && <small>编辑中，已暂停发送这条消息。</small>}{item.status === 'uncertain' && <small className="queue-warning">送达状态待确认，请检查对话；不会自动重发。</small>}<div className="queue-actions"><button aria-label={`编辑消息：${item.text}`} disabled={disabled || item.status === 'uncertain'} onClick={() => void onAction('hold', item).then(() => { setEditing(item.id); setText(item.text); }).catch(() => {})}><Pencil size={13} />编辑</button><button disabled={disabled || !canSend || item.status !== 'queued'} onClick={() => void onAction('send', item).catch(() => {})}><ArrowUp size={14} />现在发送</button><button aria-label={`移除消息：${item.text}`} disabled={disabled} onClick={() => void onAction('remove', item).catch(() => {})}><X size={14} />移除</button></div></>}
    </div>)}</div>
  </details>;
}
