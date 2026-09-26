import { RemoteClient, RemoteError } from './client';
import type { ImageAttachment, ImageUpload } from './types';
import type { ConversationProjection } from './conversationProjection';
import { normalizePrompt, type ChatMessage } from '../lib/chat-transcript';

export const IMAGE_LIMIT = 4 * 1024 * 1024;
export const IMAGE_CHUNK = 256 * 1024;
export interface ImageDraft { id: string; name: string; blob: Blob }
export function imageId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function imagePrompt(text: string, images: ImageAttachment[]) {
  return images.length ? `${text.trim() ? text : '请参考这些图片。'}\n\n参考图片：\n${images.map(image => `- ${image.reference}`).join('\n')}` : text;
}
export function imageMessage(text: string, images: ImageAttachment[]) {
  const index = text.lastIndexOf('参考图片：');
  if (index < 0) return { text, images: [] as ImageAttachment[] };
  let rest = text.slice(index + '参考图片：'.length).trim();
  const found: ImageAttachment[] = [];
  // Older terminal echoes can lose LF characters from pasted prompts. Accept
  // either layout, but only consume exact, known attachment paths all the way
  // to the end. A path mentioned in ordinary prose is not an image envelope.
  while (rest.startsWith('-') && found.length < 4) {
    rest = rest.slice(1).trimStart();
    const quote = /^["'`]/.test(rest) ? rest[0] : '';
    if (quote) rest = rest.slice(1);
    if (rest.startsWith('\\\\?\\')) rest = rest.slice(4);
    const image = images.find(image => {
      const reference = image.reference.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
      const candidate = rest.slice(0, reference.length).replace(/\\/g, '/');
      return /^[A-Za-z]:\//.test(reference) ? reference.toLowerCase() === candidate.toLowerCase() : reference === candidate;
    });
    if (!image || found.some(item => item.id === image.id)) return { text, images: [] as ImageAttachment[] };
    rest = rest.slice(image.reference.replace(/^\\\\\?\\/, '').length);
    if (quote) { if (!rest.startsWith(quote)) return { text, images: [] as ImageAttachment[] }; rest = rest.slice(1); }
    found.push(image); rest = rest.trim();
  }
  return found.length && !rest ? { text: text.slice(0, index).trimEnd(), images: found } : { text, images: [] as ImageAttachment[] };
}
export function canonicalImagePrompt(text: string, images: ImageAttachment[]) {
  const message = imageMessage(text, images);
  return message.images.length ? imagePrompt(message.text, message.images) : text;
}
export function sameImagePrompt(left: string, right: string, images: ImageAttachment[]) {
  if (normalizePrompt(left) === normalizePrompt(right)) return true;
  const a = imageMessage(left, images), b = imageMessage(right, images);
  if (!a.images.length || a.images.length !== b.images.length || a.images.some((image, i) => image.id !== b.images[i].id)) return false;
  const equal = (x: string, y: string) => normalizePrompt(x) === normalizePrompt(y);
  // Only repair the historical LF loss when attachment identity also agrees.
  // Do not remove spaces from arbitrary prompts or merge repeated user turns.
  return equal(a.text, b.text) || equal(a.text.replace(/\r?\n/g, ''), b.text) || equal(a.text, b.text.replace(/\r?\n/g, ''));
}
export function imageMessages(messages: ChatMessage[], images: ImageAttachment[]) {
  return images.length ? messages.map(message => {
    if (message.role !== 'user') return message;
    const content = canonicalImagePrompt(message.content, images);
    return content === message.content ? message : { ...message, content };
  }) : messages;
}
// VT output can split the native multiline prompt at its blank lines. Merge
// only an exact known image prompt, or an adjacent verified image footer.
// An assistant's independent mention of a local path remains ordinary text.
export function imageProjection(projection: ConversationProjection, prompts: string[], images: ImageAttachment[]): ConversationProjection {
  if (!images.length) return projection;
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const compact = (text: string) => normalize(text.replace(/\r?\n/g, ''));
  const known = prompts.filter(text => imageMessage(text, images).images.length).map(text => ({ text, normalized: normalize(text), compact: compact(text) }));
  const events = [];
  for (let i = 0; i < projection.events.length; i++) {
    const original = projection.events[i];
    const event = original.kind === 'user' ? { ...original, text: known.find(item => sameImagePrompt(original.text, item.text, images))?.text || canonicalImagePrompt(original.text, images) } : original;
    if (event.kind !== 'user') { events.push(event); continue; }
    let joined = event.text, matched = false;
    for (let j = i + 1; j < projection.events.length && projection.events[j].kind === 'assistant'; j++) {
      joined += `\n\n${projection.events[j].text}`;
      const exact = known.find(item => sameImagePrompt(item.text, joined, images));
      const adjacentFooter = j === i + 1 && imageMessage(`\n\n${projection.events[j].text}`, images).images.length > 0;
      if (exact || adjacentFooter) { events.push({ ...event, text: exact?.text || canonicalImagePrompt(joined, images) }); i = j; matched = true; break; }
      if (!known.some(item => item.normalized.startsWith(normalize(joined)) || item.compact.startsWith(compact(joined)))) break;
    }
    if (!matched) events.push(event);
  }
  return { ...projection, events };
}
export function imageError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    IMAGE_TOO_LARGE: '图片太大，请选择更小的图片或截图。', IMAGE_COUNT: '每条消息最多添加 4 张图片。',
    INVALID_IMAGE: '无法读取这张图片，请改用 PNG、JPEG 或 WebP 图片。', IMAGE_UNSUPPORTED: '当前会话暂不支持图片，请使用 Claude 或 Codex。',
    IMAGE_NOT_FOUND: '电脑上的图片已不可用，请重新上传后发送。', IMAGE_STORAGE_FULL: '当前会话的图片空间已满，请开启新会话。',
    IMAGE_CONFLICT: '图片上传内容不一致，请移除后重新选择。', IMAGE_OFFSET: '上传进度已变化，请重试。',
    IMAGE_WRITE_FAILED: '电脑无法保存图片，请检查临时目录的可用空间。', IMAGE_IN_USE: '图片已被消息使用，无法删除。',
    IMAGE_CANCELLED: '已取消上传，图片和草稿已保留。',
  };
  return messages[code] || '图片上传未完成，图片和草稿已保留，可重新点击发送。';
}
export async function prepareImage(file: File): Promise<Blob> {
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
  if (!/^image\/(png|jpeg|webp|gif|avif|heic|heif)$/i.test(file.type) && !(file.type === '' && /\.(png|jpe?g|webp|gif|avif|heic|heif)$/i.test(file.name))) throw new Error('INVALID_IMAGE');
  const source = URL.createObjectURL(file); const image = new Image();
  try {
    image.src = source; await image.decode().catch(() => { throw new Error('INVALID_IMAGE'); });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32_000_000) throw new Error('IMAGE_TOO_LARGE');
    let scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('INVALID_IMAGE');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // Decode and re-encode: no SVG, original filenames or EXIF metadata are
      // ever used as executable content or file paths on the desktop.
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (blob && blob.size <= IMAGE_LIMIT) return blob;
      scale *= .75;
    }
    throw new Error('IMAGE_TOO_LARGE');
  } finally { URL.revokeObjectURL(source); }
}
export function toBase64(bytes: Uint8Array) {
  let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
export async function uploadImage(client: RemoteClient, session: string, image: ImageDraft, signal: AbortSignal, progress: (fraction: number) => void): Promise<ImageAttachment> {
  let status: ImageUpload = { received: 0, image: null };
  try { status = await client.images<ImageUpload>(session, { action: 'status', id: image.id }, signal); }
  catch (error) { if (!(error instanceof RemoteError && error.message === 'IMAGE_NOT_FOUND')) throw error; }
  if (status.image) { progress(1); return status.image; }
  let offset = status.received;
  if (!Number.isInteger(offset) || offset < 0 || offset > image.blob.size) throw new Error('IMAGE_OFFSET');
  while (offset < image.blob.size) {
    if (signal.aborted) throw new Error('IMAGE_CANCELLED');
    const bytes = new Uint8Array(await image.blob.slice(offset, offset + IMAGE_CHUNK).arrayBuffer());
    status = await client.images<ImageUpload>(session, { action: 'upload', id: image.id, name: image.name, total: image.blob.size, offset, data_base64: toBase64(bytes) }, signal);
    if (status.received < offset + bytes.length || status.received > image.blob.size) throw new Error('IMAGE_OFFSET');
    offset = status.received; progress(offset / image.blob.size);
  }
  if (!status.image) throw new Error('INVALID_IMAGE');
  return status.image;
}
export async function readImage(client: RemoteClient, session: string, image: ImageAttachment, signal: AbortSignal): Promise<Blob> {
  if (image.size <= 0 || image.size > IMAGE_LIMIT) throw new Error('IMAGE_TOO_LARGE');
  const pieces: BlobPart[] = []; let offset = 0;
  while (offset < image.size) {
    const part = await client.images<{ data_base64: string; next: number; total: number }>(session, { action: 'read', id: image.id, offset }, signal);
    const bytes = Uint8Array.from(atob(part.data_base64), c => c.charCodeAt(0));
    if (part.next !== offset + bytes.length || !bytes.length || part.total !== image.size || part.next > image.size) throw new Error('INVALID_IMAGE');
    pieces.push(bytes); offset = part.next;
  }
  return new Blob(pieces, { type: 'image/png' });
}

// Keep draft blobs in IndexedDB instead of filling localStorage with base64.
let database: Promise<IDBDatabase> | undefined;
function imageDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Unavailable')); return; }
    const request = indexedDB.open('sinos-mobile-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function loadImageDraft(session: string): Promise<ImageDraft[]> {
  const db = await imageDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('images').objectStore('images').get(session);
    request.onsuccess = () => resolve((Array.isArray(request.result) ? request.result : []).filter((item: ImageDraft) => item.blob instanceof Blob && item.blob.size <= IMAGE_LIMIT && typeof item.id === 'string' && typeof item.name === 'string').slice(0, 4));
    request.onerror = () => reject(request.error);
  });
}
export async function saveImageDraft(session: string, items: ImageDraft[]) {
  const db = await imageDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('images', 'readwrite'); const store = transaction.objectStore('images');
    if (items.length) store.put(items, session); else store.delete(session);
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  });
}
