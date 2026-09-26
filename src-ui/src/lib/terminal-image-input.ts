import { clipboardRead, clipboardReadImages } from './clipboard';
import { commands } from '../tauri';
import { formatPathsForInsert } from './file-drop';

export const isImagePath = (path: string) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(path);
export type ImageInputNotice = { kind: 'working' | 'done' | 'error'; count?: number; error?: string } | null;

/** Keep image pastes separate: Codex recognizes one local image per paste.
 * A combined "a.png b.png" paste becomes ordinary text instead of attachments.
 * The controller is bound to one terminal, even if the active tab changes.
 */
export function createTerminalImageInput(target: {
  isLive: () => boolean;
  bracketedPaste: () => boolean;
  tool?: string | null;
  settlePaste?: () => Promise<void>;
  write: (data: string) => Promise<void>;
  pasteText: (text: string) => void;
  notice: (value: ImageInputNotice) => void;
}) {
  let busy = false;
  const writePaste = async (text: string) => {
    if (!target.isLive()) throw new Error('IMAGE_TERMINAL_CLOSED');
    const normalized = text.replace(/\r\n?/g, '\n');
    await target.write(target.bracketedPaste() ? `\x1b[200~${normalized}\x1b[201~` : normalized);
  };
  const insertFiles = async (paths: string[]) => {
    if (paths.some(path => /[\x00-\x1f\x7f]/.test(path))) throw new Error('IMAGE_INVALID_PATH'); // eslint-disable-line no-control-regex
    const images = paths.filter(isImagePath);
    if (images.length) await commands.prepareImagePaths(images);
    // Validate all files before inserting any so a missing file cannot cause a
    // partial image paste. Preserve ordinary files in a mixed drag as well.
    const unique = [...new Set(paths)];
    if (target.tool === 'claude' && target.bracketedPaste() && images.length) {
      // Claude coalesces consecutive pastes for 100 ms. Separate quoted paths
      // with newlines *inside* one bracketed paste so its parser sees each file.
      await writePaste(unique.map(path => formatPathsForInsert([path]).trimEnd()).join('\n'));
    } else for (const path of unique) {
      await writePaste(formatPathsForInsert([path]));
      if (target.tool === 'codex' && images.length) {
        // Windows ConPTY/Codex may coalesce consecutive writes into a text
        // burst despite separate bracket markers. Let each attachment settle.
        await (target.settlePaste?.() ?? new Promise<void>(resolve => setTimeout(resolve, 200)));
      }
    }
    target.notice(images.length ? { kind: 'done', count: new Set(images).size } : null);
  };
  const run = async (operation: () => Promise<void>) => {
    if (busy || !target.isLive()) return;
    busy = true; target.notice({ kind: 'working' });
    try { await operation(); }
    catch (error) { if (target.isLive()) target.notice({ kind: 'error', error: String(error) }); }
    finally {
      busy = false;
      if (!target.isLive()) target.notice(null);
    }
  };
  return {
    get busy() { return busy; },
    paste: () => run(async () => {
      const images = await clipboardReadImages();
      if (images.length) await insertFiles(images);
      else {
        const text = await clipboardRead();
        if (!target.isLive()) return;
        if (text) target.pasteText(text);
        target.notice(null);
      }
    }),
    drop: (paths: string[]) => run(() => insertFiles(paths)),
  };
}
