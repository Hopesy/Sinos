import type { ChatAttachment } from '../lib/chat-content';

export function ConversationAttachments({ items }: { items?: ChatAttachment[] }) {
  if (!items?.length) return null;
  return <div className="conversation-attachments">{items.map((item, index) => <figure key={index}>
    {item.src && item.kind === 'image' && <img src={item.src} alt={item.label} loading="lazy" />}
    {item.src && item.kind === 'audio' && <audio src={item.src} controls preload="none" aria-label={item.label} />}
    <figcaption>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.label}</a> : item.label}{!item.src && !item.url && item.kind !== 'resource' && <small>附件未包含可预览数据</small>}</figcaption>
  </figure>)}</div>;
}
