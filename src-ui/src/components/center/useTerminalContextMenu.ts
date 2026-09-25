import { useRef, type MouseEvent } from 'react';
import { clipboardWrite } from '../../lib/clipboard';
import type { TermContextMenuState } from './TermContextMenu';

/** Capture before xterm's native handlers focus/select its hidden textarea.
 * A menu must own its selection snapshot, not query a changed selection later. */
export function useTerminalContextMenu(readSelection: () => string, setMenu: (menu: TermContextMenuState | null) => void) {
  const pressed = useRef<string | null>(null);
  return {
    onMouseDownCapture(event: MouseEvent<HTMLElement>) {
      const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey && /mac/i.test(navigator.platform));
      pressed.current = secondary ? readSelection() : null;
      if (secondary) { event.preventDefault(); event.stopPropagation(); }
    },
    onContextMenuCapture(event: MouseEvent<HTMLElement>) {
      event.preventDefault(); event.stopPropagation();
      const pointer = pressed.current !== null || event.button === 2;
      const text = pressed.current ?? readSelection(); pressed.current = null;
      const menu = { x: event.clientX, y: event.clientY, hasSelection: Boolean(text), text };
      if (pointer && text) {
        setMenu(null);
        // Keep an enabled retry action if the system clipboard is busy.
        void clipboardWrite(text, { throwOnError: true }).catch(() => setMenu(menu));
      } else setMenu(menu);
    },
  };
}

export function selectedSurfaceText(root: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return '';
  return root.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : '';
}
