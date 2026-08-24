// Explorer.tsx — Left panel: file tree synced from terminal CWD

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../../store/app-state';
import type { IconTheme, ToolType } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { isMaskTintTheme } from '../../lib/personalization';
import { ScrollPanel } from '../common/ScrollPanel';
import { clipboardWrite } from '../../lib/clipboard';
import { beginExplorerDrag } from '../../lib/explorer-drag';
import { useFileStats, useDirtyDirs } from '../../lib/git-status';
import { refreshHistory } from '../../lib/history-cache';
import { commands, onSelfUpdateProgress } from '../../tauri';
import type { DirEntryInfo } from '../../tauri';
import { HistoryBoard } from '../right/HistoryBoard';
import './Explorer.css';

// Snapshot lifecycle and the `+N -M` map live in lib/file-stats.tsx so the
// right-side ChangesBoard can read the same data when the left panel is
// collapsed. Explorer is now a pure consumer.
const normPath = (p: string) => p.replace(/\\/g, '/');
const basenamePath = (p: string) => normPath(p).replace(/\/+$/, '').split('/').pop() || p;

function formatExplorerError(error: unknown, t: ReturnType<typeof useT>): string {
  const message = String(error);
  if (message.includes('FS_PATH_OUTSIDE_WORKSPACE')) return t('explorer.error_outside_workspace');
  if (message.includes('FS_WORKSPACE_ROOT_PROTECTED')) return t('explorer.error_workspace_root');
  if (message.includes('FS_INVALID_NAME')) return t('explorer.error_invalid_name');
  if (message.includes('FS_PASTE_SAME_PATH')) return t('explorer.error_paste_same_path');
  if (message.includes('FS_PASTE_INTO_SELF')) return t('explorer.error_paste_self');
  if (message.includes('FS_DESTINATION_EXISTS')) return t('explorer.error_destination_exists');
  if (message.includes('FS_SYMLINK_UNSUPPORTED')) return t('explorer.error_symlink');
  if (message.includes('FS_WORKSPACE_UNAVAILABLE')) return t('explorer.error_workspace_unavailable');
  if (message.includes('FS_TARGET_UNAVAILABLE')) return t('explorer.error_target_unavailable');
  if (message.includes('FS_PATH_UNAVAILABLE')) return t('explorer.error_path_unavailable');
  if (message.includes('FS_SOURCE_UNAVAILABLE')) return t('explorer.error_path_unavailable');
  if (message.includes('FS_DELETE_FAILED')) return t('explorer.error_delete_failed');
  if (message.includes('FS_RENAME_FAILED')) return t('explorer.error_rename_failed');
  if (message.includes('FS_MOVE_FAILED')) return t('explorer.error_move_failed');
  if (message.includes('FS_COPY_ROLLBACK_FAILED')) return t('explorer.error_copy_rollback_failed');
  if (message.includes('FS_COPY_FAILED')) return t('explorer.error_copy_failed');
  if (message.includes('FS_PARENT_UNAVAILABLE') || message.includes('FS_DESTINATION_UNAVAILABLE')) return t('explorer.error_path_unavailable');
  if (message.includes('FS_INVALID_ACTION')) return t('explorer.error_generic');
  if (message.includes('FS_DIRECTORY_UNAVAILABLE') || message.includes('FS_ENTRY_UNAVAILABLE')) return t('explorer.directory_error');
  return message.replace(/^Error:\s*/, '') || t('explorer.error_generic');
}

// ─── Context Menu ────────────────────────────────────────────────────────────

export interface CtxMenuState {
  x: number;
  y: number;
  absolutePath: string;
  relativePath: string;
  isDir?: boolean;
  workspaceRoot?: string;
  onRename?: () => void;
  onOpenEditor?: () => void;
  // ChangesBoard reuses this menu read-only — the audit view shouldn't
  // mutate the agent's just-edited files. Hides cut/copy/paste/rename/delete
  // + the relative-path entry.
  compact?: boolean;
}

// Module-level clipboard: survives menu close/open cycles
let fsClipboard: { action: 'copy' | 'cut'; path: string } | null = null;

// OpenClaw (persona forge), Hermes Agent, and Remote Terminal are
// directory-agnostic — they don't bind to a local project folder, so the
// workspace dir-picker and file tree are hidden for these tabs (clicking
// the picker would otherwise restart the PTY in a new cwd, which makes
// no sense — Remote runs over SSH/WebSocket on a different host).
const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>(['openclaw', 'hermes', 'remote']);

// Dispatch a custom event to refresh any BrowserDirNode that owns that directory
function dispatchFsRefresh(dirPath: string) {
  window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath } }));
}

export function ContextMenu({ menu, onClose, onError }: { menu: CtxMenuState; onClose: () => void; onError?: (error: unknown) => void }) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const closeKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeKey);
    };
  }, [onClose]);

  const copyPath = (text: string) => {
    clipboardWrite(text);
    onClose();
  };

  const handleCut = () => {
    fsClipboard = { action: 'cut', path: menu.absolutePath };
    onClose();
  };

  const handleCopy = () => {
    fsClipboard = { action: 'copy', path: menu.absolutePath };
    onClose();
  };

  const handlePaste = async () => {
    if (!fsClipboard) return;
    const targetDir = menu.isDir ? menu.absolutePath : menu.absolutePath.replace(/[\\/][^\\/]+$/, '');
    const sourcePath = fsClipboard.path;
    const action = fsClipboard.action;
    if (!menu.workspaceRoot) {
      onError?.('FS_WORKSPACE_UNAVAILABLE');
      onClose();
      return;
    }
    try {
      await commands.fsPaste(action, sourcePath, targetDir, menu.workspaceRoot);
      
      // Refresh the destination directory where we just pasted
      dispatchFsRefresh(targetDir);
      
      // If we cut a file, the original source location also needs a refresh to show the file is gone!
      if (action === 'cut') {
        const sourceDir = sourcePath.replace(/[\\/][^\\/]+$/, '');
        dispatchFsRefresh(sourceDir);
        fsClipboard = null;
      }
    } catch (e) {
      console.error('[Explorer] paste failed:', e);
      onError?.(e);
    }
    onClose();
  };

  const handleDelete = async () => {
    const itemName = basenamePath(menu.absolutePath);
    const message = menu.isDir
      ? t('explorer.delete_confirm_dir', { name: itemName, path: menu.absolutePath })
      : t('explorer.delete_confirm_file', { name: itemName, path: menu.absolutePath });
    if (!window.confirm(message)) {
      onClose();
      return;
    }
    if (!menu.workspaceRoot) {
      onError?.('FS_WORKSPACE_UNAVAILABLE');
      onClose();
      return;
    }
    onClose();
    try {
      await commands.fsDelete(menu.absolutePath, menu.workspaceRoot);
      const parentDir = menu.absolutePath.replace(/[\\/][^\\/]+$/, '');
      dispatchFsRefresh(parentDir);
    } catch (e) {
      console.error('[Explorer] delete failed:', e);
      onError?.(e);
    }
  };

  const handleRename = () => {
    onClose();
    menu.onRename?.();
  };

  const handleShowInFolder = async () => {
    onClose();
    try {
      await commands.showInFolder(menu.absolutePath);
    } catch (e) {
      console.error('[Explorer] show in folder failed:', e);
    }
  };

  // Files from the workspace open in the in-app editor; folders and read-only
  // menus still use the OS default opener.
  const handleOpen = async () => {
    onClose();
    if (menu.onOpenEditor) {
      menu.onOpenEditor();
      return;
    }
    try {
      await commands.openUrl(menu.absolutePath);
    } catch (e) {
      console.error('[Explorer] open failed:', e);
    }
  };

  const canPaste = !!fsClipboard;

  // Smart menu positioning to prevent off-screen clipping
  const MENU_WIDTH = 220;
  const MENU_HEIGHT = 320; // Safe upper bound for full ctx menu

  const isBottomOverflow = menu.y + MENU_HEIGHT > window.innerHeight;
  const isRightOverflow = menu.x + MENU_WIDTH > window.innerWidth;

  const style: React.CSSProperties = {
    position: 'fixed',
    ...(isBottomOverflow 
         ? { bottom: Math.max(0, window.innerHeight - menu.y) } 
         : { top: menu.y }),
    ...(isRightOverflow 
         ? { right: Math.max(0, window.innerWidth - menu.x) } 
         : { left: menu.x })
  };

  return createPortal(
    <div className="ctx-menu" ref={menuRef} style={style}>
       {/* Primary action: open in the in-app editor for workspace files. */}
      <button className="ctx-menu-item" onClick={handleOpen}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 3h6v6"/>
          <path d="M10 14 21 3"/>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        </svg>
         {menu.onOpenEditor ? t('menu.open_editor') : t('menu.open')}
      </button>
      <div className="ctx-menu-divider" />
      {/* Path copy group */}
      <button className="ctx-menu-item" onClick={() => copyPath(menu.absolutePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        {t('menu.copy_abs')}
      </button>
      <button className="ctx-menu-item" onClick={() => copyPath(menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        {t('menu.copy_rel')}
      </button>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item ctx-menu-hint" onClick={() => copyPath('@' + menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/>
          <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>
        </svg>
        {t('menu.copy_ref')}
      </button>

      {/* File operation group — hidden in compact mode (read-only audit view) */}
      {!menu.compact && <>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleCut}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="20" r="2"/><circle cx="18" cy="20" r="2"/>
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
        </svg>
        {t('menu.cut')}
      </button>
      <button className="ctx-menu-item" onClick={handleCopy}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
        </svg>
        {t('menu.copy')}
      </button>
      {canPaste && (
        <button className="ctx-menu-item" onClick={handlePaste}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
          </svg>
          {t('menu.paste')}
        </button>
      )}
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleRename}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
        </svg>
        {t('menu.rename')}
      </button>
      <button className="ctx-menu-item" onClick={handleDelete}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="m19 6-.867 13.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        {t('menu.delete')}
      </button>
      </>}
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleShowInFolder}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m19 20-3-3m0 0a4 4 0 1 0-5.656-5.656A4 4 0 0 0 16 17z"/>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        {t('menu.show_in_folder')}
      </button>
    </div>,
    document.body
  );
}

function formatBytes(b: number) {
  return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB';
}

const IMAGE_EXTENSIONS = new Set([
  'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp',
]);

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return !!ext && IMAGE_EXTENSIONS.has(ext);
}

type ImageOpenHandler = (entry: DirEntryInfo, siblings: DirEntryInfo[], workspaceRoot: string) => void;

// ─── Icon Themes ──────────────────────────────────────────────────────────────
// Every theme ships a complete 19-SVG set under /icons/themes/<id>/.
// No root-level fallback: adding a theme = dropping a new folder + listing it
// in ICON_ART_THEMES. Non-theme UI assets (CLI tool logos, terminal icons,
// etc.) live under /icons/tools/ and are unrelated to this subsystem.

function getIconPath(theme: IconTheme, name: string): string {
  return `/icons/themes/${theme}/${name}`;
}

function getFileIconSrc(ext: string, theme: IconTheme): string {
  return `/icons/themes/${theme}/${getFileIcon(ext)}`;
}

/** Renders a theme icon. For mask-tint themes, uses a <span> with mask-image
 *  so `background-color: var(--accent)` paints the silhouette. For color
 *  themes, falls back to a plain <img>. */
function ThemedIcon({ src, alt, onFallback }: {
  src: string;
  alt: string;
  onFallback?: string;
}) {
  const { state: { iconTheme } } = useAppState();
  if (isMaskTintTheme(iconTheme)) {
    return (
      <span
        className="icon-svg icon-svg-mask"
        role="img"
        aria-label={alt}
        style={{ WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` }}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="icon-svg"
      onError={onFallback ? (e) => (e.currentTarget.src = onFallback) : undefined}
    />
  );
}


function getFileIcon(ext: string): string {
  const m: Record<string, string> = {
    rs: 'rs.svg', js: 'js.svg', jsx: 'jsx.svg', ts: 'ts.svg', tsx: 'tsx.svg',
    py: 'py.svg', go: 'go.svg', java: 'java.svg', c: 'c.svg', cpp: 'cpp.svg',
    h: 'cpp.svg', html: 'html.svg', css: 'css.svg', json: 'json.svg',
    md: 'md.svg', toml: 'toml.svg', sh: 'sh.svg', pyw: 'py.svg',
  };
  return m[ext.toLowerCase()] || 'file.svg';
}


// ─── Lazy Directory Browser Node ─────────────────────────────────────────────

/** A single expandable directory node for the "My Computer" tab.
 *  Loads children lazily from the backend on first expand. */
function BrowserDirNode({ name, dirPath, workspaceRoot, icon, onCtxMenu, onError, onOpenImage }: { name: string; dirPath: string; workspaceRoot: string; icon?: string; onCtxMenu: (menu: CtxMenuState) => void; onError: (error: unknown) => void; onOpenImage: ImageOpenHandler }) {
  const { state: { iconTheme } } = useAppState();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntryInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // True when any descendant file has uncommitted changes. Used to tint the
  // folder name as a "trail" leading to the change — folded folders still
  // signal that something inside is modified, so users don't have to expand
  // the whole tree to find the +/- badge. Icon stays untouched (icon themes
  // own their own coloring; tinting the icon would fight Material/Seti).
  // O(1) check against the precomputed dirty-dirs set (was an O(open-folders ×
  // changes) scan of the whole change list on every poll — a main-thread cost).
  const dirtyDirs = useDirtyDirs();
  const hasDirtyDescendant = useMemo(
    () => dirtyDirs.has(normPath(dirPath).replace(/\/+$/, '')),
    [dirtyDirs, dirPath],
  );

  const loadChildren = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const entries = await commands.listDirectory(dirPath);
      setChildren(entries);
    } catch (e) {
      console.warn('[Explorer] list_directory failed:', e);
      setChildren([]);
      setLoadError(true);
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [dirPath, onError]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (children === null && !loading) void loadChildren();
  };

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);

  // Listen for fs-refresh events targeting our own directory
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ dirPath: string }>;
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
      if (norm(ev.detail.dirPath) === norm(dirPath)) {
        if (open) {
          void loadChildren();
        } else {
          setChildren(null);
          setLoadError(false);
        }
      }
    };
    window.addEventListener('fs-refresh', handler);
    return () => window.removeEventListener('fs-refresh', handler);
  }, [dirPath, loadChildren, open]);

  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);

  const commitRename = async () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setRenameVal(name);
      setRenaming(false);
      return;
    }
    if (renameVal.trim() && renameVal !== name) {
      const absPath = dirPath.replace(/\\/g, '/');
      try {
        await commands.fsRename(absPath, renameVal.trim(), workspaceRoot);
        // Notify parent directory to refresh
        const parentDir = absPath.replace(/\/[^/]+$/, '');
        dispatchFsRefresh(parentDir);
      } catch (e) { console.error('[Explorer] rename failed:', e); onError(e); }
    }
    setRenaming(false);
  };

  const handleDirCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: dirPath.replace(/\\/g, '/'),
      relativePath: dirPath.replace(/\\/g, '/'),
      isDir: true,
      workspaceRoot,
      onRename: () => {
        cancelRenameRef.current = false;
        setRenameVal(name);
        setRenaming(true);
      },
    });
  };

  // Pointer-based drag (HTML5 drag is captured by Tauri's WebView2 drop
  // handler on Windows — see explorer-drag.ts). Threshold-gated so a plain
  // click toggles open/close without a phantom drop.
  const onDirMouseDown = (e: React.MouseEvent) => {
    if (renaming) return;
    beginExplorerDrag(dirPath, e);
  };

  return (
    <div className="tree-dir">
      <div
        className={`tree-dir-header ${renaming ? 'renaming' : ''}${hasDirtyDescendant ? ' has-dirty' : ''}`}
        onClick={() => !renaming && toggle()}
        onContextMenu={handleDirCtxMenu}
        onMouseDown={onDirMouseDown}
      >
        <span className={`tree-arrow ${open ? '' : 'closed'}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
        <span className="tree-icon">
          <ThemedIcon src={icon || getIconPath(iconTheme, open ? 'folder-open.svg' : 'folder-closed.svg')} alt="dir" />
        </span>
        <span className="tree-name" style={{ display: renaming ? 'none' : undefined }}>{name}</span>
        <input
          ref={renameInputRef}
          className="tree-rename-input"
          style={{ display: renaming ? undefined : 'none' }}
          value={renameVal}
          onChange={e => setRenameVal(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancelRenameRef.current = true;
              e.currentTarget.blur();
            }
          }}
          onClick={e => e.stopPropagation()}
        />
      </div>
      {open && (
        <div className="tree-children">
          {loading ? (
            <div className="tree-state" role="status">{t('explorer.loading')}</div>
          ) : loadError ? (
            <div className="tree-state tree-state-error">
              <span>{t('explorer.directory_error')}</span>
              <button type="button" onClick={(event) => { event.stopPropagation(); void loadChildren(); setOpen(true); }}>
                {t('editor.retry')}
              </button>
            </div>
          ) : children && children.length === 0 ? (
            <div className="tree-state" role="status">{t('explorer.empty')}</div>
          ) : children?.slice().sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return a.name.localeCompare(b.name);
      }).map(entry => (
            entry.is_dir ? (
              <BrowserDirNode key={entry.path} name={entry.name} dirPath={entry.path} workspaceRoot={workspaceRoot} onCtxMenu={onCtxMenu} onError={onError} onOpenImage={onOpenImage} />
            ) : (
              <BrowserFileNode key={entry.path} entry={entry} parentDirPath={dirPath} siblings={children ?? []} workspaceRoot={workspaceRoot} onCtxMenu={onCtxMenu} onError={onError} onOpenImage={onOpenImage} />
            )
          ))}
        </div>
      )}
    </div>
  );
}

/** A leaf file node inside the My Computer tree with inline rename support. */
function BrowserFileNode({ entry, parentDirPath, siblings, workspaceRoot, onCtxMenu, onError, onOpenImage }: {
  entry: DirEntryInfo;
  parentDirPath: string;
  siblings: DirEntryInfo[];
  workspaceRoot: string;
  onCtxMenu: (menu: CtxMenuState) => void;
  onError: (error: unknown) => void;
  onOpenImage: ImageOpenHandler;
}) {
  const { state: { iconTheme }, dispatch } = useAppState();
  const fileStats = useFileStats();
  const stats = fileStats?.get(normPath(entry.path));
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(entry.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);

  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);

  const commitRename = async () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setRenameVal(entry.name);
      setRenaming(false);
      return;
    }
    if (renameVal.trim() && renameVal !== entry.name) {
      try {
        await commands.fsRename(entry.path, renameVal.trim(), workspaceRoot);
        const parentNorm = parentDirPath.replace(/\\/g, '/');
        dispatchFsRefresh(parentNorm);
      } catch (e) { console.error('[Explorer] rename failed:', e); onError(e); }
    }
    setRenaming(false);
  };

  const handleCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: entry.path.replace(/\\/g, '/'),
      relativePath: entry.path.replace(/\\/g, '/'),
      isDir: false,
      workspaceRoot,
      onRename: () => {
        cancelRenameRef.current = false;
        setRenameVal(entry.name);
        setRenaming(true);
      },
      onOpenEditor: () => {
        if (isImageFile(entry.name)) {
          onOpenImage(entry, siblings, workspaceRoot);
        } else {
          dispatch({ type: 'OPEN_EDITOR', path: entry.path, workspaceRoot });
        }
      },
    });
  };

  const onFileMouseDown = (e: React.MouseEvent) => {
    if (renaming) return;
    beginExplorerDrag(entry.path, e);
  };

  const handleFileDoubleClick = () => {
    if (isImageFile(entry.name)) {
      onOpenImage(entry, siblings, workspaceRoot);
    } else {
      dispatch({ type: 'OPEN_EDITOR', path: entry.path, workspaceRoot });
    }
  };

  return (
    <div
      className={`tree-file ${renaming ? 'renaming' : ''}`}
      onContextMenu={handleCtxMenu}
      onMouseDown={onFileMouseDown}
      onDoubleClick={handleFileDoubleClick}
      title={isImageFile(entry.name) ? 'Double-click to open image tab' : undefined}
    >
      <span className="tree-icon">
        <ThemedIcon
          src={getFileIconSrc(entry.name.split('.').pop() || '', iconTheme)}
          alt="file"
          onFallback={getIconPath(iconTheme, 'file.svg')}
        />
      </span>
      <span className="tree-fname" style={{ display: renaming ? 'none' : undefined }}>{entry.name}</span>
      <input
        ref={renameInputRef}
        className="tree-rename-input"
        style={{ display: renaming ? undefined : 'none' }}
        value={renameVal}
        onChange={e => setRenameVal(e.target.value)}
        onBlur={commitRename}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelRenameRef.current = true;
            e.currentTarget.blur();
          }
        }}
        onClick={e => e.stopPropagation()}
      />
      {stats ? (
        <span className="tree-badge tree-badge-diff">
          <span className="diff-add">+{stats.added}</span>
          <span className="diff-del">-{stats.deleted}</span>
        </span>
      ) : (
        <span className="tree-badge">{formatBytes(entry.size)}</span>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function Explorer() {
  const { state, dispatch } = useAppState();
  const t = useT();

  const activeSession = state.terminals.find(t => t.id === state.activeTerminalId);
  const folderPath = activeSession?.folderPath || null;

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const reportError = useCallback((error: unknown) => {
    setOperationError(formatExplorerError(error, t));
  }, [t]);
  const handleCtxMenu = useCallback((menu: CtxMenuState) => setCtxMenu(menu), []);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const handleOpenImage = useCallback((entry: DirEntryInfo, siblings: DirEntryInfo[], workspaceRoot: string) => {
    const items = siblings
      .filter(item => !item.is_dir && isImageFile(item.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map(item => ({ path: item.path, name: item.name, size: item.size }));
    dispatch({ type: 'OPEN_IMAGE', path: entry.path, workspaceRoot, items });
  }, [dispatch]);

  // Workspace tree: read one directory level at a time from the OS — same
  // semantics as Windows Explorer / Finder / GNOME Files. No filtering,
  // no recursion, no MAX_FILES cap. Subdirs lazy-load via BrowserDirNode.
  const [rootEntries, setRootEntries] = useState<DirEntryInfo[] | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState(false);
  const rootLoadGenerationRef = useRef(0);
  const reloadRoot = useCallback(async () => {
    if (!folderPath) return;
    const generation = ++rootLoadGenerationRef.current;
    setRootLoading(true);
    setRootError(false);
    try {
      const entries = await commands.listDirectory(folderPath);
      if (generation === rootLoadGenerationRef.current) setRootEntries(entries);
    } catch (error) {
      if (generation === rootLoadGenerationRef.current) {
        setRootEntries([]);
        setRootError(true);
        reportError(error);
      }
    } finally {
      if (generation === rootLoadGenerationRef.current) setRootLoading(false);
    }
  }, [folderPath, reportError]);

  useEffect(() => {
    if (!folderPath) {
      rootLoadGenerationRef.current += 1;
      setRootEntries(null);
      setRootError(false);
      setRootLoading(false);
      return;
    }
    void reloadRoot();
  }, [folderPath, reloadRoot]);

  // Snapshot lifecycle and the +N/-M map are owned by FileStatsProvider at
  // App level (lib/file-stats.tsx) so the right-side ChangesBoard can read
  // the same data when Explorer is unmounted. Reload root level when
  // fs-refresh targets the workspace root itself; subdirectory refreshes
  // are handled inside each BrowserDirNode.
  useEffect(() => {
    if (!folderPath) return;
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const target = norm(folderPath);
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ dirPath: string }>;
      const dir = norm(ev.detail.dirPath);
      if (dir === target) {
        void reloadRoot();
      }
    };
    window.addEventListener('fs-refresh', handler);
    return () => window.removeEventListener('fs-refresh', handler);
  }, [folderPath, reloadRoot]);

  // Update check
  const [hasUpdate, setHasUpdate] = useState(false);
  // The brand (logo + title + the self-update button) renders here but DISPLAYS
  // in the titlebar's left slot via portal — so it keeps all its Explorer-local
  // self-update state untouched, and hides together with the left panel (this
  // component unmounts when the panel is hidden, which is exactly what we want:
  // no need to relocate the brand to the centre). Slot resolves after mount.
  const [brandSlot, setBrandSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setBrandSlot(document.getElementById('titlebar-brand-slot')); }, []);
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const [local, remote] = await Promise.all([
          getVersion(),
          fetch('https://api.github.com/repos/Hopesy/sinos/releases/latest', {
            headers: { Accept: 'application/vnd.github+json' },
          }).then(r => r.json()),
        ]);
        const isNewer = (r: string, l: string) => {
          const rv = r.split('.').map(Number);
          const lv = l.split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            if ((rv[i] ?? 0) > (lv[i] ?? 0)) return true;
            if ((rv[i] ?? 0) < (lv[i] ?? 0)) return false;
          }
          return false;
        };
        const remoteVersion = String(remote?.tag_name ?? '').replace(/^v/, '');
        if (remoteVersion && isNewer(remoteVersion, local)) setHasUpdate(true);
      } catch { /* offline or fetch failed — silent */ }
    };
    checkUpdate();
  }, []);

  // In-app self-update. Click the logo's update icon → a circular ring fills
  // as the installer downloads, then the wizard launches and the app exits.
  // Windows only; elsewhere (or on download failure) fall back to the page.
  const [installing, setInstalling] = useState(false);
  const [installPct, setInstallPct] = useState(0);
  const [installPhase, setInstallPhase] = useState<
    'speed_test' | 'downloading' | 'launching' | 'error' | null
  >(null);
  const handleSelfUpdate = useCallback(async () => {
    if (installing) return;
    if (!navigator.userAgent.toLowerCase().includes('win')) {
      commands.openUrl('https://github.com/Hopesy/sinos/releases/latest');
      return;
    }
    setInstalling(true);
    setInstallPhase('speed_test');
    setInstallPct(0);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onSelfUpdateProgress((p) => {
        setInstallPhase(p.status);
        setInstallPct(p.percent);
      });
      await commands.downloadAndInstallUpdate();
      // Success: installer launched and the app is about to exit — leave the
      // ring as-is until the window goes away.
    } catch {
      commands.openUrl('https://github.com/Hopesy/sinos/releases/latest');
      setInstalling(false);
      setInstallPhase(null);
      setInstallPct(0);
    } finally {
      unlisten?.();
    }
  }, [installing]);

  // Persist last-selected left tab, same pattern as TaskBoard's right tab.
  const [activeTab, setActiveTab] = useState<'workspace' | 'history'>(() => {
    try {
      const saved = localStorage.getItem('cc-left-tab');
      if (saved === 'workspace' || saved === 'history') return saved;
    } catch { /* Best-effort operation; failure is non-fatal. */ }
    return 'workspace';
  });
  useEffect(() => {
    try { localStorage.setItem('cc-left-tab', activeTab); } catch { /* Best-effort operation; failure is non-fatal. */ }
  }, [activeTab]);

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true });
      if (selected && typeof selected === 'string') {
        const activeTerminalId = state.activeTerminalId;
        const tool = activeSession?.tool;

        if (activeTerminalId && tool) {
          // 1. Update this tab's folderPath so the restarted terminal knows its CWD
          dispatch({ type: 'SET_FOLDER', path: selected });

          // 2. Force unmount-remount of the TierTerminal to restart the Agent in the new dir
          dispatch({ type: 'RESTART_TERMINAL', id: activeTerminalId, newId: crypto.randomUUID() });
        }
      }
    } catch (err) {
      console.error('[Explorer] Failed to open folder:', err);
    }
  };

  // OS-level fs watcher — picks up changes from the terminal CLI, editors,
  // git, or any process writing under folderPath. The backend emits the
  // same `fs-refresh` event shape that right-click menu actions dispatch
  // synthetically, so the listener above handles both paths uniformly.
  //
  // CRITICAL ordering: register the Tauri `listen('fs-refresh')` BEFORE
  // calling `startFsWatcher`. The previous order (start → import → listen)
  // dropped any event fired in the few-ms gap between the OS watcher
  // arming and the JS subscription registering — exactly the window in
  // which an editor's save burst or `npm install` first writes hit.
  useEffect(() => {
    if (!folderPath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (cancelled) return;
        const handle = await listen<{ dirPath: string }>('fs-refresh', (event) => {
          // Re-dispatch onto `window` so Explorer's existing listeners
          // (workspace re-scan + BrowserDirNode child refresh) both fire.
          window.dispatchEvent(new CustomEvent('fs-refresh', {
            detail: { dirPath: event.payload.dirPath },
          }));
        });
        if (cancelled) { handle(); return; }
        unlisten = handle;

        // Listener is live — now arm the OS watcher.
        await commands.startFsWatcher(folderPath);
      } catch (err) {
        console.warn('[Explorer] fs watcher setup failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      commands.stopFsWatcher().catch(() => {});
    };
  }, [folderPath]);


  return (
    <div className="panel panel-left explorer-panel" data-icon-theme={state.iconTheme}>
      {/* Brand + theme/lang controls */}
      {brandSlot && createPortal(
        <div className="brand">
          <img src="/sinos-icon.svg" alt="" className="brand-icon" />
          <span>{t('app.title')}</span>
          {hasUpdate && (
            <button
              className={`icon-btn xs update-check-btn update-available${installing ? ' is-installing' : ''}`}
              onClick={handleSelfUpdate}
              disabled={installing}
              aria-label="Update Sinos CLI"
            >
              {installing ? (
                <svg
                  className={`update-ring${installPhase === 'speed_test' ? ' spin' : ''}`}
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                >
                  <circle className="update-ring-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.6" />
                  <circle
                    className="update-ring-progress"
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    transform="rotate(-90 12 12)"
                    strokeDasharray={
                      installPhase === 'speed_test'
                        ? `${2 * Math.PI * 9 * 0.25} ${2 * Math.PI * 9}`
                        : 2 * Math.PI * 9
                    }
                    strokeDashoffset={
                      installPhase === 'speed_test'
                        ? 0
                        : 2 * Math.PI * 9 * (1 - installPct / 100)
                    }
                  />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              )}
            </button>
          )}
        </div>
        
        ,
        brandSlot
      )}

      <div className="explorer-tabs">
        <button
          className={`explorer-tab ${activeTab === 'workspace' ? 'active' : ''}`}
          onClick={() => setActiveTab('workspace')}
        >
          {t('explorer.tab.workspace')}
        </button>
        <button
          className={`explorer-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => { setActiveTab('history'); refreshHistory(); }}
        >
          {t('explorer.tab.history')}
        </button>
      </div>

      {(activeTab === 'workspace' && activeSession?.tool && !CWD_AGNOSTIC_TOOLS.has(activeSession.tool)) && (
        <button
          className="workspace-dir-btn"
          onClick={handleOpenFolder}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"></path>
          </svg>
          <span className="workspace-dir-path">
            {activeSession.folderPath
              ? `⁦${activeSession.folderPath}⁩`
              : t('explorer.workspace.select-dir')}
          </span>
        </button>
      )}

      {/* File list Content */}
      <div className="panel-content explorer-content">
        {activeTab === 'history' ? (
          // HistoryBoard returns a fragment and was originally hosted inside
          // .task-board which provided the 16px gutter. In Explorer's flex
          // shell that padding doesn't exist, so we wrap to restore it.
          <div className="explorer-history-host"><HistoryBoard /></div>
        ) : (!activeSession?.tool || CWD_AGNOSTIC_TOOLS.has(activeSession.tool)) ? (
          // Launchpad (no tool picked yet) or a CWD-agnostic tool
          // (OpenClaw / Hermes Agent) — both render the same blank
          // state: a faint folder glyph, no file tree, no dir picker.
          // Without this gate the workspace would show the default
          // cwd's tree even before the user has chosen a tool.
          <div className="empty-state" style={{ justifyContent: 'center', gap: '10px' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
        ) : !folderPath ? (
          // Waiting state — terminal will sync the directory automatically
          <div className="empty-state" style={{ justifyContent: 'center', gap: '10px' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
        ) : rootEntries === null || rootLoading ? (
          <ScrollPanel>
            <div className="file-tree-container" style={{ pointerEvents: 'none' }} role="status" aria-label={t('explorer.loading')}>
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', opacity: Math.max(0.1, 1 - i * 0.08) }}>
                  <div className="shimmer-box" style={{ width: 14, height: 14, borderRadius: 'var(--radius-xs)', flexShrink: 0 }}></div>
                  <div className="shimmer-box" style={{ width: `${30 + (i * 7) % 40}%`, height: 12, borderRadius: 'var(--radius-xs)' }}></div>
                </div>
              ))}
            </div>
          </ScrollPanel>
        ) : rootError ? (
          <div className="explorer-state explorer-state-error" role="alert">
            <div>{t('explorer.root_error')}</div>
            <button type="button" onClick={() => void reloadRoot()}>{t('editor.retry')}</button>
          </div>
        ) : rootEntries?.length === 0 ? (
          <div className="explorer-state" role="status">
            <div>{t('explorer.empty')}</div>
          </div>
        ) : (
          <ScrollPanel>
            <div className="file-tree-container">
              {rootEntries!.slice().sort((a, b) => {
                if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                return a.name.localeCompare(b.name);
              }).map(entry => (
                entry.is_dir ? (
                <BrowserDirNode key={entry.path} name={entry.name} dirPath={entry.path} workspaceRoot={folderPath!} onCtxMenu={handleCtxMenu} onError={reportError} onOpenImage={handleOpenImage} />
                ) : (
                  <BrowserFileNode key={entry.path} entry={entry} parentDirPath={folderPath!} siblings={rootEntries ?? []} workspaceRoot={folderPath!} onCtxMenu={handleCtxMenu} onError={reportError} onOpenImage={handleOpenImage} />
                )
              ))}
            </div>
          </ScrollPanel>
        )}
      </div>



      {operationError && (
        <div className="explorer-operation-error" role="alert">
          <span>{operationError}</span>
          <button type="button" aria-label={t('editor.close_error')} onClick={() => setOperationError(null)}>×</button>
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={closeCtxMenu} onError={reportError} />}

      {/* Theme + language pickers now live in the titlebar-gear SettingsModal
          (App-level), not here. */}
    </div>
  );
}
