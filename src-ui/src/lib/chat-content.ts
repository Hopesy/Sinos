export interface ChatAttachment { kind: 'image' | 'audio' | 'resource'; label: string; src?: string; url?: string }
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** Decode content blocks, never print image/audio bytes as JSON in a bubble. */
export function chatContent(value: unknown): { text: string; attachments: ChatAttachment[] } {
  const attachments: ChatAttachment[] = [];
  function read(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') {
      if (v.startsWith('{') || v.startsWith('[')) {
        try {
          const parsed: unknown = JSON.parse(v);
          if ((object(parsed) && (Array.isArray(parsed.content) || (object(parsed.metadata) && typeof parsed.output === 'string'))) || (Array.isArray(parsed) && parsed.every(item => object(item) && typeof item.type === 'string'))) return read(parsed);
        } catch { /* Ordinary tool output is not necessarily JSON. */ }
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(read).filter(Boolean).join('\n');
    if (!object(v)) return String(v);
    const type = String(v.type || '');
    if (/^(?:input_?image|image|local_image|input_?audio|audio|local_audio)$/i.test(type)) {
      const kind = /audio/i.test(type) ? 'audio' : 'image';
      const raw = v.image_url ?? v.imageUrl ?? v.audio_url ?? v.audioUrl ?? (object(v.source) ? v.source.url : undefined);
      const reference = typeof raw === 'string' ? raw : object(raw) && typeof raw.url === 'string' ? raw.url : '';
      const source = object(v.source) ? v.source : v;
      const mime = source.mimeType ?? source.mime_type ?? source.media_type;
      const inline = reference.startsWith('data:') ? reference : typeof source.data === 'string' && typeof mime === 'string' ? `data:${mime};base64,${source.data}` : '';
      // Only bounded passive media; no SVG, HTML, file:// or automatic remote loads.
      const safe = inline.length <= 8 * 1024 * 1024 && /^data:(?:image\/(?:png|jpeg|gif|webp)|audio\/(?:mpeg|mp3|wav|ogg|webm));base64,[A-Za-z0-9+/=\r\n]+$/.test(inline);
      const path = typeof v.path === 'string' ? v.path : typeof v.file_id === 'string' ? v.file_id : '';
      const label = `${kind === 'image' ? '图片' : '音频'}${path ? `：${path}` : ''}`;
      attachments.push({ kind, label, ...(safe ? { src: inline } : {}), ...(/^https?:\/\//i.test(reference) ? { url: reference } : {}) });
      return '';
    }
    if (type === 'resource' && object(v.resource)) {
      if (typeof v.resource.text === 'string') return v.resource.text;
      attachments.push({ kind: 'resource', label: `资源：${String(v.resource.uri || v.resource.mimeType || '附件')}` });
      return '';
    }
    if (type === 'resource_link') {
      attachments.push({ kind: 'resource', label: String(v.title || v.name || '资源'), ...(typeof v.uri === 'string' && /^https?:\/\//i.test(v.uri) ? { url: v.uri } : {}) });
      return '';
    }
    if (typeof v.text === 'string') return v.text;
    if (object(v.metadata) && typeof v.output === 'string') return v.output;
    if (Array.isArray(v.content)) {
      const text = read(v.content);
      const structured = v.structuredContent ?? v.structured_content;
      return [text, structured != null ? JSON.stringify(structured, null, 2) : ''].filter(Boolean).join('\n');
    }
    return JSON.stringify(v, null, 2);
  }
  return { text: read(value), attachments };
}
