import { useCallback, useEffect, useMemo, useState } from 'react';
import { commands, isTauri } from '../../tauri';
import type { DirEntryInfo } from '../../tauri';
import { useT } from '../../i18n/useT';
import './ImageSurface.css';

export interface ImageSurfaceItem {
  path: string;
  name: string;
  size: number;
}

interface ImageSurfaceProps {
  path: string;
  initialItems?: ImageSurfaceItem[];
  isActive: boolean;
  onPathChange: (path: string) => void;
}

const imageExtensions = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp']);

function isImageFile(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase();
  return Boolean(extension && imageExtensions.has(extension));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function pathKey(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function basename(path: string): string {
  return normalizePath(path).split('/').pop() || path;
}

function parentPath(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function localFileUrl(path: string): string {
  return `file:///${normalizePath(path)}`;
}

async function resolveImageUrl(path: string): Promise<string> {
  if (!isTauri) return localFileUrl(path);
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    return convertFileSrc(path);
  } catch {
    return localFileUrl(path);
  }
}

function sortImages(items: ImageSurfaceItem[]): ImageSurfaceItem[] {
  return items
    .filter(item => isImageFile(item.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

export function ImageSurface({ path, initialItems, isActive, onPathChange }: ImageSurfaceProps) {
  const t = useT();
  const propItems = useMemo(() => sortImages(initialItems ?? []), [initialItems]);
  const [directoryItems, setDirectoryItems] = useState<{ directory: string; items: ImageSurfaceItem[] } | null>(null);
  const [imageState, setImageState] = useState<{ path: string; src: string; loadError: boolean; loaded: boolean }>({ path: '', src: '', loadError: false, loaded: false });
  const [viewState, setViewState] = useState<{ path: string; zoom: number; rotation: number }>({ path: '', zoom: 1, rotation: 0 });
  const directory = parentPath(path);
  const items = directoryItems?.directory === directory ? directoryItems.items : propItems;
  const src = imageState.path === path ? imageState.src : '';
  const loadError = imageState.path === path && imageState.loadError;
  const loaded = imageState.path === path && imageState.loaded;
  const zoom = viewState.path === path ? viewState.zoom : 1;
  const rotation = viewState.path === path ? viewState.rotation : 0;

  const currentItem = useMemo(() => {
    const existing = items.find(item => pathKey(item.path) === pathKey(path));
    return existing ?? { path, name: basename(path), size: 0 };
  }, [items, path]);
  const currentIndex = Math.max(0, items.findIndex(item => pathKey(item.path) === pathKey(path)));
  const canPrevious = currentIndex > 0;
  const canNext = currentIndex >= 0 && currentIndex < items.length - 1;

  useEffect(() => {
    let cancelled = false;
    void commands.listDirectory(directory).then((entries: DirEntryInfo[]) => {
      if (cancelled) return;
      const discovered = sortImages(entries.filter(entry => !entry.is_dir).map(entry => ({ path: entry.path, name: entry.name, size: entry.size })));
      if (discovered.length > 0) {
        setDirectoryItems({
          directory,
          items: discovered.some(item => pathKey(item.path) === pathKey(path)) ? discovered : [{ path, name: basename(path), size: 0 }, ...discovered],
        });
      }
    }).catch(() => {
      // The initial sibling snapshot is still enough to view the image when
      // the directory cannot be refreshed (for example in browser preview).
    });
    return () => { cancelled = true; };
  }, [directory, path]);

  useEffect(() => {
    let cancelled = false;
    void resolveImageUrl(path).then(url => {
      if (!cancelled) {
        setImageState({ path, src: url, loadError: false, loaded: false });
        setViewState({ path, zoom: 1, rotation: 0 });
      }
    });
    return () => { cancelled = true; };
  }, [path]);

  const move = useCallback((delta: number) => {
    const next = items[currentIndex + delta];
    if (next) onPathChange(next.path);
  }, [currentIndex, items, onPathChange]);

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && canPrevious) {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'ArrowRight' && canNext) {
        event.preventDefault();
        move(1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setViewState(state => ({ path, zoom: Math.min(5, (state.path === path ? state.zoom : 1) + 0.1), rotation: state.path === path ? state.rotation : 0 }));
      } else if (event.key === '-') {
        event.preventDefault();
        setViewState(state => ({ path, zoom: Math.max(0.1, (state.path === path ? state.zoom : 1) - 0.1), rotation: state.path === path ? state.rotation : 0 }));
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        setViewState(state => ({ path, zoom: state.path === path ? state.zoom : 1, rotation: ((state.path === path ? state.rotation : 0) + 90) % 360 }));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canNext, canPrevious, isActive, move, path]);

  return (
    <div className="image-surface" role="region" aria-label={t('image_viewer.title')}>
      <header className="image-surface-toolbar">
        <div className="image-surface-heading">
          <span className="image-surface-title" title={path}>{currentItem.name}</span>
          <span className="image-surface-counter">{items.length > 0 ? `${currentIndex + 1} / ${items.length}` : '1 / 1'}</span>
        </div>
        <div className="image-surface-actions">
          <button type="button" onClick={() => setViewState({ path, zoom: Math.max(0.1, zoom - 0.1), rotation })} aria-label={t('image_viewer.zoom_out')}>−</button>
          <button type="button" className="image-surface-zoom" onClick={() => setViewState({ path, zoom: 1, rotation: 0 })}>{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setViewState({ path, zoom: Math.min(5, zoom + 0.1), rotation })} aria-label={t('image_viewer.zoom_in')}>+</button>
          <button type="button" onClick={() => setViewState({ path, zoom, rotation: (rotation + 90) % 360 })} aria-label={t('image_viewer.rotate')}>↻</button>
        </div>
      </header>
      <main
        className="image-surface-stage"
        onWheel={event => {
          event.preventDefault();
          setViewState({ path, zoom: Math.max(0.1, Math.min(5, zoom + (event.deltaY < 0 ? 0.1 : -0.1))), rotation });
        }}
      >
        {src && !loadError ? (
          <img
            src={src}
            alt={currentItem.name}
            draggable={false}
            onLoad={() => setImageState(state => state.path === path ? { ...state, loaded: true } : state)}
            onError={() => setImageState(state => state.path === path ? { ...state, loadError: true } : state)}
            style={{ opacity: loaded ? 1 : 0, transform: `scale(${zoom}) rotate(${rotation}deg)` }}
          />
        ) : loadError ? (
          <div className="image-surface-error">
            <div>{t('image_viewer.load_failed')}</div>
            <code>{path}</code>
          </div>
        ) : (
          <div className="image-surface-loading" role="status">{t('image_viewer.loading')}</div>
        )}
        {canPrevious && <button type="button" className="image-surface-nav image-surface-nav-prev" onClick={() => move(-1)} aria-label={t('image_viewer.previous')}>‹</button>}
        {canNext && <button type="button" className="image-surface-nav image-surface-nav-next" onClick={() => move(1)} aria-label={t('image_viewer.next')}>›</button>}
      </main>
      <footer className="image-surface-footer">
        <span>{t('image_viewer.hint')}</span>
        <span>{formatBytes(currentItem.size)}</span>
      </footer>
    </div>
  );
}
