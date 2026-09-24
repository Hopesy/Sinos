import { useEffect, useRef, useState } from 'react';
import { RemoteClient } from './client';
import type { ImageAttachment } from './types';
import { imageError, imageId, loadImageDraft, prepareImage, saveImageDraft, uploadImage, type ImageDraft } from './images';

export interface DraftPreview extends ImageDraft { url: string }
export function useImageAttachments(client: RemoteClient, session: string, enabled: boolean, online: boolean) {
  const [items, setItems] = useState<DraftPreview[]>([]);
  const [known, setKnown] = useState<ImageAttachment[]>([]);
  const [loaded, setLoaded] = useState(!enabled);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef<DraftPreview[]>([]), alive = useRef(true), selecting = useRef(false);
  const upload = useRef<AbortController | null>(null);
  function remember(images: ImageAttachment[]) { setKnown(previous => [...new Map([...previous, ...images].map(image => [image.id, image])).values()]); }
  function persist(next: DraftPreview[]) {
    current.current = next; setItems(next);
    void saveImageDraft(session, next.map(({ id, name, blob }) => ({ id, name, blob }))).catch(() => {
      if (alive.current) setNotice('图片仅保留在当前页面，刷新前请先发送。');
    });
  }
  useEffect(() => {
    alive.current = true; let disposed = false;
    if (enabled) void loadImageDraft(session).then(drafts => {
      if (disposed) return;
      current.current = drafts.map(item => ({ ...item, url: URL.createObjectURL(item.blob) })); setItems(current.current);
    }).catch(() => {}).finally(() => { if (!disposed) setLoaded(true); });
    return () => { disposed = true; alive.current = false; upload.current?.abort(); for (const item of current.current) URL.revokeObjectURL(item.url); current.current = []; };
  }, [session, enabled]);
  useEffect(() => {
    if (!enabled || !online) return;
    let disposed = false; const controller = new AbortController();
    const refresh = async () => {
      if (document.hidden) return;
      try { const result = await client.images<{ images: ImageAttachment[] }>(session, { action: 'list' }, controller.signal); if (!disposed) remember(result.images); } catch { /* Drafts stay usable while offline. */ }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 15000);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [client, session, enabled, online]);
  async function select(files: File[]) {
    if (!enabled || !loaded || selecting.current || upload.current) return;
    selecting.current = true; setPreparing(true); setError('');
    const remaining = 4 - current.current.length;
    if (files.length > remaining) setError(imageError(new Error('IMAGE_COUNT')));
    try {
      for (const file of files.slice(0, remaining)) {
        try {
          const blob = await prepareImage(file);
          if (!alive.current) return;
          persist([...current.current, { id: imageId(), name: file.name || 'photo.png', blob, url: URL.createObjectURL(blob) }]);
        } catch (cause) { if (alive.current) setError(imageError(cause)); }
      }
    } finally { selecting.current = false; if (alive.current) setPreparing(false); }
  }
  function clear(ids: string[]) {
    const removed = current.current.filter(item => ids.includes(item.id));
    persist(current.current.filter(item => !ids.includes(item.id))); for (const item of removed) URL.revokeObjectURL(item.url);
  }
  function remove(id: string) {
    if (upload.current || selecting.current) return;
    clear([id]);
    // A queued/sent image is retained by the desktop even if this draft is
    // removed after a lost acknowledgement. The server owns reference checks.
    if (online) void client.images(session, { action: 'remove', id }).catch(() => {});
  }
  async function ensureUploaded(): Promise<ImageAttachment[]> {
    if (upload.current || selecting.current) throw new Error('IMAGE_CANCELLED');
    const controller = new AbortController(); upload.current = controller;
    const snapshot = [...current.current], result: ImageAttachment[] = [];
    try {
      for (let i = 0; i < snapshot.length; i++) {
        result.push(await uploadImage(client, session, snapshot[i], controller.signal, fraction => {
          if (alive.current) setProgress(`上传图片 ${i + 1}/${snapshot.length} · ${Math.round(fraction * 100)}%`);
        }));
      }
      if (controller.signal.aborted || !alive.current) throw new Error('IMAGE_CANCELLED');
      remember(result); return result;
    } catch (cause) { throw controller.signal.aborted ? new Error('IMAGE_CANCELLED') : cause; }
    finally { upload.current = null; if (alive.current) setProgress(''); }
  }
  return { items, known, loaded, preparing, progress, error, notice, select, remove, clear, ensureUploaded, cancel: () => upload.current?.abort(), dismissError: () => setError('') };
}
