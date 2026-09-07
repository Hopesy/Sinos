import { useCallback, useEffect, useRef, useState } from 'react';
import { commands, type DirEntryInfo } from '../tauri';
import { normalizeProjectPath } from '../store/app-state';

// Keep the last successful listing mounted during refresh. One request per
// directory, with at most one deferred follow-up for a burst of filesystem events.
export function useDirectory(path: string | null, active: boolean, onError: (error: unknown) => void) {
  const [snapshot, setSnapshot] = useState<{ path: string | null; entries: DirEntryInfo[] | null; error: boolean }>({ path, entries: null, error: false });
  const refreshRef = useRef(() => {});
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  const reload = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    if (!path || !active) return;
    let cancelled = false;
    let inFlight = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (cancelled) return;
      if (inFlight) { pending = true; return; }
      inFlight = true;
      try {
        const entries = await commands.listDirectory(path);
        if (!cancelled) setSnapshot(prev => {
          const same = prev.path === path && !prev.error && prev.entries?.length === entries.length
            && prev.entries.every((e, i) => e.path === entries[i].path && e.name === entries[i].name
              && e.is_dir === entries[i].is_dir && e.size === entries[i].size);
          return same ? prev : { path, entries, error: false };
        });
      } catch (error) {
        if (!cancelled) {
          setSnapshot(prev => ({ path, entries: prev.path === path ? prev.entries : null, error: true }));
          onErrorRef.current(error);
        }
      } finally {
        inFlight = false;
        if (pending && !cancelled) { pending = false; schedule(); }
      }
    };
    const schedule = () => {
      if (inFlight) { pending = true; return; }
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; void load(); }, 250);
    };
    refreshRef.current = schedule;
    const handler = (event: Event) => {
      const dir = (event as CustomEvent<{ dirPath?: string }>).detail?.dirPath;
      if (dir && normalizeProjectPath(dir) === normalizeProjectPath(path)) schedule();
    };
    window.addEventListener('fs-refresh', handler);
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      refreshRef.current = () => {};
      window.removeEventListener('fs-refresh', handler);
    };
  }, [path, active]);

  const current = snapshot.path === path;
  return { entries: current ? snapshot.entries : null, error: current && snapshot.error, reload };
}
