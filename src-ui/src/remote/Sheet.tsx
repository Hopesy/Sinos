import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icons';

export function Sheet({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`mobile-sheet${wide ? ' is-wide' : ''}`} aria-label={title} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
    <div className="mobile-sheet-inner"><div className="mobile-sheet-handle" /><header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></header>{children}</div>
  </dialog>;
}
