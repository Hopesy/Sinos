import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ConversationVisible } from './conversation-visibility';

/** Release derived rendering for background tabs while retaining layout space
 * and the surrounding controls' expansion, selection and session state. */
export function DeferredConversationContent({ children, className }: { children: ReactNode; className?: string }) {
  const visible = useContext(ConversationVisible);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!visible || !node) return;
    const measure = () => {
      // A display:none ancestor reports zero during the tab transition.
      if (node.getClientRects().length) setHeight(node.getBoundingClientRect().height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return <div ref={ref} className={className} style={visible ? undefined : { height }}>
    {visible ? children : null}
  </div>;
}
