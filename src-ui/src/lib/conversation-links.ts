import { createContext } from 'react';

export const ConversationDirectory = createContext<string | null>(null);
export interface ConversationLink { target: string; local: boolean }

export function conversationLink(href: string, cwd: string | null): ConversationLink | null {
  if (!href || href.startsWith('#')) return null;
  if (/^(https?:\/\/|mailto:)/i.test(href)) return { target: href, local: false };
  let path = href;
  try {
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      path = url.host ? `//${url.host}${url.pathname}` : url.pathname.replace(/^\/([a-z]:\/)/i, '$1');
    } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
    path = decodeURIComponent(path.replace(/#.*$/, '')).replace(/:(\d+)(:\d+)?$/, '').replace(/\\/g, '/');
  } catch { return null; }
  if (!path || path.includes('\0')) return null;
  if (!/^(?:[a-z]:\/|\/)/i.test(path)) {
    if (!cwd) return null;
    path = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${path}`;
  }
  const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop(); }
    else parts.push(part);
  }
  const target = prefix + parts.join('/');
  return { target: /^[a-z]:$/i.test(target) ? `${target}/` : target, local: true };
}
