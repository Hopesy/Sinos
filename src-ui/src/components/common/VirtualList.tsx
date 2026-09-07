import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './ScrollPanel.css';

const ROW_HEIGHT = 32;
const OVERSCAN = 8;

/** Fixed-height viewport: scrolling never accumulates off-screen DOM rows. */
export function VirtualList<T extends { key: string }>({ items, renderItem }: {
  items: T[];
  renderItem: (item: T) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setViewport(prev => {
      const next = { top: el.scrollTop, height: el.clientHeight };
      return prev.top === next.top && prev.height === next.height ? prev : next;
    });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer.disconnect(); el.removeEventListener('scroll', update); };
  }, []);
  // Clamp before rendering if the result shrinks while scrolled near the bottom.
  const top = Math.min(viewport.top, Math.max(0, items.length * ROW_HEIGHT - viewport.height));
  const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  return (
    <div ref={ref} className="scroll-panel" data-virtual-list>
      <div className="changes-list" style={{ height: items.length * ROW_HEIGHT, position: 'relative', padding: 0 }}>
        {items.slice(start, end).map((item, offset) => (
          <div key={item.key} className="changes-virtual-row" style={{ position: 'absolute', top: (start + offset) * ROW_HEIGHT, height: ROW_HEIGHT, width: '100%' }}>
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
