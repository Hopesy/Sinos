import { useEffect } from 'react';
import { invoke } from '../../tauri';

/** Reveal after the themed startup surface commits and paints. The native timeout remains
 * available if the WebView fails before React can mount. */
export function RevealMainWindow({ onRevealed }: { onRevealed?: () => void } = {}) {
  useEffect(() => {
    let active = true;
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => { void invoke('show_main_window').catch(() => {}).then(() => { if (active) onRevealed?.(); }); });
    });
    return () => {
      active = false;
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [onRevealed]);
  return null;
}
