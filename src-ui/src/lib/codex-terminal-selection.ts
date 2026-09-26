/** Codex's mouse-mode selection lives in the TUI, not in xterm/DOM.
 * Observe the SGR gestures actually sent to the PTY (Shift-drag never gets
 * here). Ask that same selection owner to copy with a right-button report.
 * Never synthesize Ctrl+C: without a selection it would interrupt a turn.
 */
export function createCodexTerminalSelection(active: () => boolean, write: (data: string) => Promise<void>) {
  let origin: { x: number; y: number } | null = null;
  let selected = false;
  let dragging = false;
  let lastClick: { x: number; y: number; at: number } | null = null;
  const reset = () => { origin = null; selected = false; dragging = false; lastClick = null; };
  return {
    reset,
    observe(data: string) {
      if (!active()) { reset(); return; }
      // Focus reports are not editing: Codex retains its selected text after
      // blur/refocus (including the Windows IME re-anchor in TierTerminal).
      if (data === '\x1b[I' || data === '\x1b[O') { dragging = false; return; }
      // Cursor/device replies can be requested during output, with no user key.
      // eslint-disable-next-line no-control-regex
      if (/^\x1b\[[?>]?[\d;:]*[Rc]$/.test(data)) return;
      // xterm emits a complete report per onData call. Ignore wheel/motion,
      // while ordinary typing/navigation invalidates an application selection.
      // eslint-disable-next-line no-control-regex
      const reports = [...data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)];
      if (!reports.length) { reset(); return; }
      for (const report of reports) {
        const button = Number(report[1]), x = Number(report[2]), y = Number(report[3]);
        if ((button & 64) || (button & 3) !== 0) continue;
        if (report[4] === 'm') { dragging = false; continue; }
        if (button & 32) {
          if (dragging && origin && (x !== origin.x || y !== origin.y)) selected = true;
        } else {
          const now = performance.now();
          selected = Boolean(lastClick && lastClick.x === x && lastClick.y === y && now - lastClick.at < 400);
          origin = { x, y }; dragging = true; lastClick = { x, y, at: now };
        }
      }
    },
    read(): (() => Promise<void>) | undefined {
      if (!active() || !selected || !origin) return undefined;
      const captured = origin;
      const { x, y } = captured;
      // Use the selected region's coordinates: the context menu itself may be
      // opened outside the transcript/composer which owns the selection.
      return async () => {
        if (!active()) throw new Error('TERMINAL_SELECTION_UNAVAILABLE');
        await write(`\x1b[<2;${x};${y}M\x1b[<2;${x};${y}m`);
        if (origin === captured) reset();
      };
    },
  };
}
