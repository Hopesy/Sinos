import { useEffect, useRef, useState } from 'react';
import { RemoteClient, storageRead, storageWrite } from './client';
import type { QueueSnapshot, QueuedPrompt } from './types';

function pendingEnqueue(sessionId: string): { text: string; id: string; attachments?: string[] } | null {
  try {
    const value = JSON.parse(storageRead(`queue-outbound-${sessionId}`, 'null'));
    return value && typeof value.text === 'string' && typeof value.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value.id) ? value : null;
  } catch { return null; }
}

export function useMessageQueue(client: RemoteClient, sessionId: string, enabled: boolean, online: boolean) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const epoch = useRef(0), operation = useRef(false);
  const outbound = useRef<{ text: string; id: string; attachments?: string[] } | null>(pendingEnqueue(sessionId));
  useEffect(() => {
    if (!enabled || !online) return;
    let disposed = false, polling = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    async function poll() {
      clearTimeout(timer);
      if (disposed) return;
      if (polling || operation.current || document.hidden) { timer = setTimeout(poll, 1500); return; }
      polling = true; controller = new AbortController(); const version = epoch.current;
      try { const next = await client.queue(sessionId, controller.signal); if (!disposed && version === epoch.current) setSnapshot(next); }
      catch { /* The workspace owns connection recovery. Never retry writes. */ }
      finally { polling = false; if (!disposed) timer = setTimeout(poll, 1200); }
    }
    refresh.current = () => void poll();
    const wake = () => { if (!document.hidden) void poll(); };
    void poll(); document.addEventListener('visibilitychange', wake);
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
  }, [client, sessionId, enabled, online]);
  async function mutate(action: 'enqueue' | 'edit' | 'remove' | 'send' | 'hold' | 'release', item: Pick<QueuedPrompt, 'id' | 'revision'> | Pick<QueuedPrompt, 'id'>, text = '', attachments?: string[]) {
    if (!enabled || !online || operation.current) return false;
    operation.current = true; epoch.current++; setBusy(true);
    try {
      const revision = 'revision' in item ? item.revision : undefined;
      const next = attachments?.length ? await client.queueAction(sessionId, action, item.id, text, revision, attachments) : await client.queueAction(sessionId, action, item.id, text, revision);
      setSnapshot(next); return true;
    }
    finally { operation.current = false; setBusy(false); refresh.current(); }
  }
  async function add(text: string, attachments?: string[]) {
    if (outbound.current?.text !== text || JSON.stringify(outbound.current.attachments || []) !== JSON.stringify(attachments || [])) {
      // getRandomValues also works on the optional HTTP LAN companion.
      const id = crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      outbound.current = { text, id, attachments };
      storageWrite(`queue-outbound-${sessionId}`, JSON.stringify(outbound.current));
    }
    const result = await mutate('enqueue', outbound.current, text, attachments);
    if (result) { outbound.current = null; storageWrite(`queue-outbound-${sessionId}`, ''); }
    return result;
  }
  return { snapshot, busy, add, mutate };
}
