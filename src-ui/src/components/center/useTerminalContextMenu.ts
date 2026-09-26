import { useCallback, useEffect, useRef, type MouseEvent } from 'react';
import { clipboardHasImage, clipboardWrite } from '../../lib/clipboard';
import type { TermContextMenuState } from './TermContextMenu';

/** Own the right-button gesture before native focus/selection handlers run.
 * Copy on press: WebViews need not deliver a later contextmenu event. */
export function useTerminalContextMenu(
  readSelection: () => string,
  setMenu: (menu: TermContextMenuState | null) => void,
  readApplicationSelection?: () => (() => Promise<void>) | undefined,
) {
  const pressed = useRef<{ menu: TermContextMenuState; pointer: boolean } | null>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);

  const closeMenu = useCallback(() => {
    request.current++;
    pressed.current = null;
    setMenu(null);
  }, [setMenu]);

  const copyMenuSelection = (menu: TermContextMenuState, keepOpen = false) => {
    if (!menu.text && !menu.copySelection) return;
    const current = ++request.current;
    setMenu(keepOpen ? menu : null);
    // Retry the same snapshot, even if output repaints or focus moves meanwhile.
    const copying = menu.text ? clipboardWrite(menu.text, { throwOnError: true }) : menu.copySelection!();
    void copying.catch(() => {
      if (current === request.current) setMenu(menu);
    });
  };
  const isSecondary = (event: MouseEvent<HTMLElement>) => event.button === 2
    || (event.button === 0 && event.ctrlKey && /mac/i.test(navigator.platform));
  // React portal events propagate through the component tree. A menu button
  // is not terminal content and must never start another copy gesture.
  const isSurface = (event: MouseEvent<HTMLElement>) => event.currentTarget.contains(event.target as Node);
  const snapshot = (event: MouseEvent<HTMLElement>): TermContextMenuState => {
    const text = readSelection();
    const copySelection = text ? undefined : readApplicationSelection?.();
    return { x: event.clientX, y: event.clientY, hasSelection: Boolean(text || copySelection), text, copySelection };
  };
  const openMenu = (menu: TermContextMenuState, autoCopy: boolean) => {
    const current = ++request.current;
    setMenu(menu);
    // An automatic text/TUI copy must not destroy a screenshot or an Explorer
    // image-file clipboard. Show the menu immediately; probe only native data.
    void clipboardHasImage().then(hasImage => {
      if (request.current !== current) return;
      const updated = { ...menu, hasImage };
      if (pressed.current?.menu === menu) pressed.current.menu = updated;
      if (autoCopy && menu.hasSelection && !hasImage) copyMenuSelection(updated, true);
      else setMenu(updated);
    }).catch(() => { /* Unknown/busy clipboard: keep it intact; explicit Copy still works. */ });
  };
  const beginPress = (event: MouseEvent<HTMLElement>, pointer: boolean) => {
    const menu = snapshot(event);
    pressed.current = { menu, pointer };
    openMenu(menu, true);
  };
  const contextMenuHandlers = {
    onPointerDownCapture(event: MouseEvent<HTMLElement>) {
      if (!isSurface(event)) return;
      if (isSecondary(event)) {
        beginPress(event, true);
        event.preventDefault(); event.stopPropagation();
      } else { pressed.current = null; closeMenu(); }
    },
    onMouseDownCapture(event: MouseEvent<HTMLElement>) {
      if (!isSurface(event)) return;
      if (isSecondary(event)) {
        // Older WebViews emit only mouse events; modern ones may emit both.
        if (!pressed.current?.pointer) beginPress(event, false);
        else pressed.current.pointer = false;
        event.preventDefault(); event.stopPropagation();
      } else { pressed.current = null; closeMenu(); }
    },
    onKeyDownCapture() {
      // Shift+F10 / Menu-key must not reuse an unfinished pointer gesture.
      pressed.current = null;
      request.current++;
    },
    onPointerCancelCapture() {
      pressed.current = null;
    },
    onContextMenuCapture(event: MouseEvent<HTMLElement>) {
      if (!isSurface(event)) return;
      event.preventDefault(); event.stopPropagation();
      const press = pressed.current; pressed.current = null;
      if (press) {
        // Copy already started on press. Keep the original menu snapshot even
        // when Codex clears its own selection after completing that copy.
        setMenu(press.menu);
        return;
      }
      const menu = snapshot(event);
      openMenu(menu, isSecondary(event));
    },
  };
  return { contextMenuHandlers, copyMenuSelection, closeMenu };
}

export function selectedSurfaceText(root: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return '';
  return root.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : '';
}
