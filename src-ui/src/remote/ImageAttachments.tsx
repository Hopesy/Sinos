import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Image as ImageIcon, X } from 'lucide-react';
import { RemoteClient } from './client';
import type { ImageAttachment } from './types';
import type { DraftPreview } from './useImageAttachments';
import { imageError, readImage } from './images';
import { Sheet } from './Sheet';

export function ImagePicker({ disabled, onSelect }: { disabled: boolean; onSelect: (files: File[]) => void }) {
  const library = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  return <div className="image-picker">
    <input ref={library} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif" multiple hidden aria-label="选择图片文件" onChange={event => { onSelect(Array.from(event.target.files || [])); event.target.value = ''; }} />
    <input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label="拍摄照片" onChange={event => { onSelect(Array.from(event.target.files || [])); event.target.value = ''; }} />
    <button className="composer-attach" aria-label="添加图片" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}><ImagePlus size={18} /></button>
    {open && <div className="image-picker-menu"><button disabled={disabled} onClick={() => { setOpen(false); library.current?.click(); }}><ImageIcon size={17} />选择图片</button><button disabled={disabled} onClick={() => { setOpen(false); camera.current?.click(); }}><Camera size={17} />拍照</button></div>}
  </div>;
}
export function DraftImages({ items, disabled, onRemove }: { items: DraftPreview[]; disabled: boolean; onRemove: (id: string) => void }) {
  const [selected, setSelected] = useState<DraftPreview | null>(null);
  return <><div className="draft-images" aria-label="图片附件">{items.map(item => <div className="draft-image" key={item.id}>
    <button className="image-thumb" aria-label={`预览图片：${item.name}`} onClick={() => setSelected(item)}><img src={item.url} alt={item.name} /></button>
    <button className="image-remove" aria-label={`移除图片：${item.name}`} disabled={disabled} onClick={() => onRemove(item.id)}><X size={13} /></button>
    <span title={item.name}>{item.name}</span>
  </div>)}</div>{selected && <Sheet title={selected.name} onClose={() => setSelected(null)}><img className="image-full" src={selected.url} alt={selected.name} /></Sheet>}</>;
}
const previewCaches = new WeakMap<RemoteClient, { values: Map<string, Promise<string>>; tail: Promise<unknown> }>();
function preview(client: RemoteClient, session: string, image: ImageAttachment) {
  let cache = previewCaches.get(client);
  if (!cache) { cache = { values: new Map(), tail: Promise.resolve() }; previewCaches.set(client, cache); }
  const key = `${session}:${image.id}`;
  if (!cache.values.has(key)) {
    const value = cache.tail.catch(() => {}).then(() => client.images<{ data_base64: string }>(session, { action: 'preview', id: image.id })).then(result => `data:image/png;base64,${result.data_base64}`);
    cache.tail = value.catch(() => {}); cache.values.set(key, value);
    void value.catch(() => cache?.values.delete(key));
    if (cache.values.size > 100) cache.values.delete(cache.values.keys().next().value!);
  }
  return cache.values.get(key)!;
}
function RemoteThumbnail({ client, session, image, onOpen }: { client: RemoteClient; session: string; image: ImageAttachment; onOpen: () => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => { let active = true; void preview(client, session, image).then(value => { if (active) setUrl(value); }).catch(() => {}); return () => { active = false; }; }, [client, session, image]);
  return <button className="image-thumb" onClick={onOpen} aria-label={`查看图片：${image.name}`}>{url ? <img src={url} alt={image.name} /> : <><ImageIcon size={22} /><small>{image.name}</small></>}</button>;
}
function RemoteImage({ client, session, image, onClose }: { client: RemoteClient; session: string; image: ImageAttachment; onClose: () => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let active = true, objectUrl = ''; const controller = new AbortController();
    void readImage(client, session, image, controller.signal).then(blob => { if (active) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(cause => { if (active) setError(imageError(cause)); });
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, session, image]);
  return <Sheet title={image.name} onClose={onClose}>{url ? <img className="image-full" src={url} alt={image.name} /> : <p role="status" className="image-loading">{error || '正在载入图片…'}</p>}</Sheet>;
}
export function MessageImages({ client, session, images }: { client: RemoteClient; session: string; images: ImageAttachment[] }) {
  const [selected, setSelected] = useState<ImageAttachment | null>(null);
  if (!images.length) return null;
  return <><div className="message-images">{images.map(image => <RemoteThumbnail key={image.id} client={client} session={session} image={image} onOpen={() => setSelected(image)} />)}</div>{selected && <RemoteImage client={client} session={session} image={selected} onClose={() => setSelected(null)} />}</>;
}
