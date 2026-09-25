import { useCallback, useEffect, useRef, useState } from 'react';
import { RemoteClient, RemoteError } from './client';
import type { Connection, RemoteState, RemoteTool } from './types';

export function useConnection(client: RemoteClient) {
  const [state, setState] = useState<RemoteState>({ sessions: [], device_name: '' });
  const [tools, setTools] = useState<RemoteTool[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false, busy = false, haveTools = false;
    const started = Date.now();
    let connectedOnce = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    async function refresh() {
      if (disposed || busy) return;
      clearTimeout(timer);
      busy = true;
      controller = new AbortController();
      let delay = 3000;
      try {
        const next = await client.state(controller.signal);
        if (disposed) return;
        connectedOnce = true; setState(next); setConnection('online'); setLastSync(Date.now());
        if (!haveTools) {
          try { const available = await client.tools(controller.signal); if (!disposed) { setTools(available); haveTools = true; } } catch { /* Retry without marking a healthy state offline. */ }
        }
      } catch (error) {
        const unauthorized = error instanceof RemoteError && error.status === 401;
        const replaced = error instanceof RemoteError && error.message === 'CONNECTION_REPLACED';
        const paused = error instanceof RemoteError && error.message === 'CONNECTION_PAUSED';
        const starting = !connectedOnce && !unauthorized && !paused && Date.now() - started < 10000;
        if (!disposed) setConnection(unauthorized ? 'unauthorized' : replaced ? 'replaced' : paused ? 'paused' : starting ? 'connecting' : 'offline');
        delay = starting ? 1000 : 6000;
      } finally {
        busy = false;
        if (!disposed) timer = setTimeout(() => { if (document.hidden) { timer = setTimeout(() => void refresh(), 10000); } else void refresh(); }, delay);
      }
    }
    const wake = () => { if (!document.hidden) void refresh(); };
    refreshRef.current = () => void refresh();
    void refresh();
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [client]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { state, tools, connection, lastSync, refresh };
}
