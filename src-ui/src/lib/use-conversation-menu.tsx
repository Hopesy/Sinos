import { useEffect, useState, type MouseEvent, type RefObject } from 'react';
import { TermContextMenu } from '../components/center/TermContextMenu';
import { useAppState } from '../store/app-state';
import { commands } from '../tauri';
import { clipboardRead, clipboardWrite } from './clipboard';
import type { ConversationLink } from './conversation-links';

export function useConversationMenu(surface: RefObject<HTMLDivElement | null>, sessionId: string, isActive: boolean) {
  const { dispatch } = useAppState();
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string; link: ConversationLink | null } | null>(null);
  const close = () => setMenu(null);
  if (!isActive && menu) setMenu(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss);
    document.addEventListener('wheel', dismiss, true);
    return () => { window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss); document.removeEventListener('wheel', dismiss, true); };
  }, [menu]);
  const onContextMenu = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('textarea,input,select')) return;
    event.preventDefault(); event.stopPropagation();
    const selection = window.getSelection();
    const text = selection?.anchorNode && surface.current?.contains(selection.anchorNode) ? selection.toString() : '';
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-conversation-target]');
    const target = anchor?.dataset.conversationTarget;
    setMenu({ x: event.clientX, y: event.clientY, selection: text, link: target ? { target, local: anchor.dataset.conversationLocal === 'true' } : null });
  };
  return {
    onContextMenu,
    onCopy: (event: React.ClipboardEvent) => {
      const selection = window.getSelection();
      if (selection?.anchorNode && surface.current?.contains(selection.anchorNode) && selection.toString()) { event.preventDefault(); void clipboardWrite(selection.toString()); }
    },
    menu: menu && <TermContextMenu menu={{ ...menu, hasSelection: !!menu.selection }} onClose={close}
      onCopy={() => { void clipboardWrite(menu.selection); close(); }}
      onPaste={() => { close(); void clipboardRead().then(text => { if (text) { dispatch({ type: 'APPEND_GAMBIT_DRAFT', id: sessionId, text }); document.querySelector<HTMLTextAreaElement>('.gambit-textarea')?.focus(); } }); }}
      onSelectAll={() => { if (surface.current) window.getSelection()?.selectAllChildren(surface.current); close(); }}
      link={menu.link ? { local: menu.link.local, onOpen: () => { void commands.openUrl(menu.link!.target).catch(error => console.warn('[Conversation] failed to open link', error)); close(); }, onCopy: () => { void clipboardWrite(menu.link!.target); close(); }, onReveal: () => { void commands.showInFolder(menu.link!.target).catch(error => console.warn('[Conversation] failed to reveal file', error)); close(); } } : undefined} />,
  };
}
