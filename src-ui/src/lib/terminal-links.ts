import type { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';

// Preserve the existing URL-only policy and stop before adjacent CJK prose.
// The addon joins soft-wrapped lines and maps Unicode cells back to columns.
const URL_RE = /(?:https?:\/\/|file:\/\/\/)[^\s<>()"'\u0080-\uFFFF]*[^\s<>()"'\u0080-\uFFFF,.!?;:]/i;

export function installTerminalLinks(term: Terminal, openUrl: (url: string) => Promise<unknown>): void {
  const activate = (event: MouseEvent, uri: string) => {
    // Selecting text or opening the context menu must not launch a browser.
    if (event.button !== 0 || term.hasSelection()) return;
    try {
      const url = new URL(uri);
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) return;
    } catch { return; }
    event.preventDefault();
    // Both plain text and OSC 8 links use the native opener, never window.open
    // (which is unreliable/blocked inside the Tauri WebView).
    void openUrl(uri).catch(error => console.warn('[terminal] Failed to open link:', error));
  };
  term.options.linkHandler = { activate, allowNonHttpProtocols: true };
  term.loadAddon(new WebLinksAddon(activate, { urlRegex: URL_RE }));
}
