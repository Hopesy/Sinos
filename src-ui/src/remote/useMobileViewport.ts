import { useEffect } from 'react';

// iOS Safari keeps the layout viewport tall when its keyboard opens. Follow
// the visible viewport so the composer and modal actions stay above it.
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (Math.abs(viewport.scale - 1) > 0.01) return;
        style.setProperty('--m-viewport-height', `${viewport.height}px`);
        style.setProperty('--m-viewport-top', `${viewport.offsetTop}px`);
        style.setProperty('--m-viewport-bottom', `${Math.max(0, innerHeight - viewport.height - viewport.offsetTop)}px`);
      });
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      for (const name of ['height', 'top', 'bottom']) style.removeProperty(`--m-viewport-${name}`);
    };
  }, []);
}
