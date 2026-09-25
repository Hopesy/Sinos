import type { TerminalInteraction } from './terminal-interaction';

export interface TerminalInteractionResponse {
  fingerprint: string;
  optionIndex: number;
  optionCount: number;
  customText?: string;
}

interface InteractionTarget {
  read: () => TerminalInteraction | null;
  isLive: () => boolean;
  applicationCursor: () => boolean;
  bracketedPaste: () => boolean;
  write: (data: string) => Promise<void>;
  submitted: (fingerprint: string) => void;
}

/** One response at a time, revalidated against the actual live terminal frame.
 * A card retained during a redraw must never answer a different question. */
export function createTerminalInteractionResponder(target: InteractionTarget) {
  let busy = false;
  let disposed = false;
  let cancelWait: (() => void) | undefined;
  const live = () => !disposed && target.isLive();
  const wait = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(() => { cancelWait = undefined; resolve(); }, ms);
    cancelWait = () => { clearTimeout(timer); cancelWait = undefined; resolve(); };
  });
  return {
    dispose() { disposed = true; cancelWait?.(); },
    async respond(request: TerminalInteractionResponse): Promise<boolean> {
      if (busy || !live()) return false;
      const current = target.read();
      if (!current || current.fingerprint !== request.fingerprint ||
          current.options.length !== request.optionCount || !Number.isInteger(request.optionIndex)) return false;
      const option = current.options[request.optionIndex];
      if (!option) return false;
      const text = request.customText?.trim();
      if (option.acceptsText ? !text : Boolean(text)) return false;
      let selection = '';
      if (current.responseMode === 'direct-text') {
        if (!text) return false;
      } else if (current.responseMode === 'digit' && option.number >= 1 && option.number <= 9) {
        selection = String(option.number);
      } else {
        if (current.focusedPosition < 0) return false;
        const delta = request.optionIndex - current.focusedPosition;
        const prefix = target.applicationCursor() ? '\x1bO' : '\x1b[';
        selection = (prefix + (delta > 0 ? 'B' : 'A')).repeat(Math.abs(delta)) + '\r';
      }
      busy = true;
      try {
        if (selection) {
          await target.write(selection);
          if (!live()) return false;
          target.submitted(current.fingerprint);
        }
        if (text) {
          if (selection) await wait(200);
          if (!live()) return false;
          const next = target.read();
          if (next && next.fingerprint !== current.fingerprint) return false;
          // Match xterm paste newline framing; strip ESC so text cannot end a
          // bracketed paste and turn the remainder into terminal commands.
          const normalized = text.replace(/\r?\n/g, '\r').replaceAll('\x1b', '');
          const payload = target.bracketedPaste() ? `\x1b[200~${normalized}\x1b[201~` : normalized;
          await target.write(payload);
          if (!live()) return false;
          await wait(170);
          if (!live()) return false;
          const beforeSubmit = target.read();
          if (beforeSubmit && beforeSubmit.fingerprint !== current.fingerprint) return false;
          await target.write('\r');
          if (!live()) return false;
          target.submitted(current.fingerprint);
        }
        return true;
      } catch {
        return false;
      } finally {
        busy = false;
      }
    },
  };
}
