import { useEffect } from 'react';
import { invoke } from '../../tauri';

/** Reveal after the themed App commits and paints. The native timeout remains
 * available if the WebView fails before React can mount. */
export function RevealMainWindow() {
  useEffect(() => {
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => { void invoke('show_main_window').catch(() => {}); });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, []);
  return null;
}
