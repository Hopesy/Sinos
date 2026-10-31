import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';

export interface TermContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
  text?: string;
  hasImage?: boolean;
  /** A TUI-owned selection (e.g. Codex mouse mode) must copy inside that TUI. */
  copySelection?: () => Promise<void>;
}

/** Shared menu for terminal and conversation output. */
export function TermContextMenu({ menu, onClose, onCopy, onPaste, onSelectAll, link }: {
  menu: TermContextMenuState;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  link?: { local: boolean; onOpen: () => void; onCopy: () => void; onReveal: () => void };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const t = useT();
  const mod = isMac ? '⌘' : 'Ctrl';

  useLayoutEffect(() => {
    const node = ref.current;
    if (node) {
      node.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - node.offsetWidth - 4))}px`;
      node.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - node.offsetHeight - 4))}px`;
    }
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const closeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeKey, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeKey, true);
    };
  }, [onClose, menu.x, menu.y]);

  return createPortal(
    <div
      ref={ref} className="term-ctx-menu" style={{ left: menu.x, top: menu.y, maxWidth: 'calc(100vw - 8px)', maxHeight: 'calc(100vh - 8px)', overflowY: 'auto' }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    >
      {link && <>
        <button type="button" className="term-ctx-item" onClick={link.onOpen}>{t('conversation.open_link')}</button>
        {link.local && <button type="button" className="term-ctx-item" onClick={link.onReveal}>{t('menu.show_in_folder')}</button>}
        <button type="button" className="term-ctx-item" onClick={link.onCopy}>{t('conversation.copy_link')}</button>
        <div className="term-ctx-sep" />
      </>}
      <button
        type="button"
        className={`term-ctx-item${menu.hasSelection ? '' : ' disabled'}`}
        disabled={!menu.hasSelection}
        onClick={onCopy}
      >
        <span>{t('menu.copy')}</span><kbd>{mod}+C</kbd>
      </button>
      <button
        type="button"
        className="term-ctx-item"
        onClick={onPaste}
      >
        <span>{t(menu.hasImage ? 'menu.paste_image' : 'menu.paste')}</span><kbd>{mod}+V</kbd>
      </button>
      <div className="term-ctx-sep" />
      <button
        type="button"
        className="term-ctx-item"
        onClick={onSelectAll}
      >
        <span>{t('menu.select_all')}</span><kbd>{mod}+A</kbd>
      </button>
    </div>,
    document.body,
  );
}
