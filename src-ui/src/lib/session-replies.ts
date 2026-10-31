import type { TerminalSession } from '../store/app-state';

const STORAGE_KEY = 'coffee:unread-session-replies';
const COUNT_KEY = 'sinos:unread-task-counts';
let unread = new Set<string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  if (Array.isArray(saved)) unread = new Set(saved.filter((key): key is string => typeof key === 'string' && !key.includes(':@')));
} catch { /* Local markers stay available when storage is unavailable. */ }
let counts = new Map<string, number>([...unread].map(key => [key, 1]));
try {
  const saved: unknown = JSON.parse(localStorage.getItem(COUNT_KEY) ?? '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    counts = new Map([...unread].map(key => [key, Math.floor(Math.max(1, Math.min(9999, Number((saved as Record<string, unknown>)[key]) || 1)))]));
  }
} catch { /* Preserve migrated markers. */ }
export interface SessionActivity { id: string; tool: string; kind: 'done' | 'wait' }
const activityListeners = new Set<(event: SessionActivity) => void>();
export const subscribeSessionActivity = (listener: (event: SessionActivity) => void) => {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
};
export function recordSessionQuestion(id: string, tool: string) {
  activityListeners.forEach(listener => listener({ id, tool, kind: 'wait' }));
}
const listeners = new Set<() => void>();
const identities = new Map<string, string>();
let visible = new Set<string>();
const reading = () => typeof document !== 'undefined' && !document.hidden && document.hasFocus();
export const sessionReplyKey = (tool: string, token: string) => `${tool}:${token}`;
export const getUnreadSessionReplies = () => unread;
export const getUnreadTaskCount = () => [...counts.values()].reduce((total, count) => total + count, 0);
export const isReadingSession = (id: string) => visible.has(id) && reading();
export const subscribeSessionReplies = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function publish(next: Set<string>) {
  unread = next;
  for (const key of counts.keys()) if (!unread.has(key)) counts.delete(key);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...unread])); } catch { /* Best effort. */ }
  try { localStorage.setItem(COUNT_KEY, JSON.stringify(Object.fromEntries(counts))); } catch { /* Best effort. */ }
  listeners.forEach(listener => listener());
}

/** Records live completions from protocol results or guarded terminal transitions. */
export function recordSessionReply(id: string, tool: string, token: string) {
  if (!token) return;
  const key = sessionReplyKey(tool, token);
  identities.set(id, key);
  if (!isReadingSession(id)) {
    counts.set(key, Math.min(9999, (counts.get(key) ?? 0) + 1));
    publish(new Set(unread).add(key));
  }
  activityListeners.forEach(listener => listener({ id, tool, kind: 'done' }));
}

export function clearUnreadTasks() { publish(new Set()); }

export function updateSessionReplyReaders(terminals: TerminalSession[], ids: string[]) {
  const next = new Set(unread);
  let changed = false;
  const live = new Set([...terminals.map(tab => tab.id), ...ids]);
  for (const id of ids) if (id.startsWith('agent:')) identities.set(id, sessionReplyKey('coffee-agent', id.slice(6)));
  for (const [id, key] of identities) if (!live.has(id)) {
    identities.delete(id);
    if (key.includes(':@') && next.delete(key)) changed = true;
  }
  for (const tab of terminals) if (tab.tool && tab.resumeToken) {
    const key = sessionReplyKey(tab.tool, tab.resumeToken), previous = identities.get(tab.id);
    if (previous && previous !== key && previous.includes(':@') && next.delete(previous)) {
      counts.set(key, Math.min(9999, (counts.get(key) ?? 0) + (counts.get(previous) ?? 1)));
      next.add(key); changed = true;
    }
    identities.set(tab.id, key);
  }
  visible = new Set(ids);
  if (reading()) for (const id of visible) {
    const key = identities.get(id);
    if (key) next.delete(key);
  }
  if (changed || next.size !== unread.size) publish(next);
}
