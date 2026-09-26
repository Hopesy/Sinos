// clipboard.ts — unified clipboard I/O for the entire UI.
//
// All clipboard reads/writes MUST go through these helpers. Direct
// `navigator.clipboard.*` and `document.execCommand('copy'|'paste')`
// calls are banned in this codebase because WebView2 shows a native
// "tauri.localhost wants to read the clipboard" permission prompt on
// every invocation, which destroys UX — especially on right-click
// paste. Tauri's clipboard-manager plugin bypasses that prompt.
//
// If you need a new context menu or keyboard shortcut that touches
// the clipboard, import from here. Do not re-derive.

import { isAndroidApp, SinosMobile } from '../remote/native/bridge';

/** Compatibility path for phone browsers without a usable async clipboard.
 * Keep the temporary selection inside the active modal: showModal() makes the
 * rest of the document inert. Never use this path inside Tauri or Android. */
function browserSelectionCopy(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const inputSelection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
    ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
  const dialog = focused?.closest('dialog[open]') ?? Array.from(document.querySelectorAll('dialog[open]')).at(-1);
  const textarea = document.createElement('textarea');
  textarea.value = text; textarea.readOnly = true; textarea.tabIndex = -1;
  textarea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;font-size:16px;';
  (dialog || document.body).appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true }); textarea.select(); textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch { return false; }
  finally {
    textarea.remove();
    try {
      if (focused?.isConnected) {
        focused.focus({ preventScroll: true });
        if (inputSelection?.start != null && inputSelection.end != null && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) {
          focused.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction || undefined);
        }
      }
      if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
    } catch { /* Focus changes must not turn a successful copy into a failure. */ }
  }
}

async function browserWrite(text: string): Promise<void> {
  // Call synchronously within the click handler, before any dynamic import or
  // await can consume the browser's transient user activation.
  let failure: unknown = new Error('CLIPBOARD_UNAVAILABLE');
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; }
    catch (error) { failure = error; }
  }
  if (!browserSelectionCopy(text)) throw failure;
}

/** Tauri uses its native plugin; the phone uses the browser on an explicit tap.
 * Legacy callers remain best-effort. Callers showing a success message can
 * request rejection so a denied write is never presented as successful. */
export async function clipboardWrite(text: string, options?: { throwOnError: boolean }): Promise<void> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
    } else {
      if (isAndroidApp) await SinosMobile.clipboardWrite({ value: text });
      else await browserWrite(text);
    }
  } catch (error) { if (options?.throwOnError) throw error; }
}

/** Read text from the system clipboard. Returns empty string on any
 *  failure (empty clipboard, permission denied, etc.) so callers can
 *  do a simple `if (text)` check without try/catch boilerplate. */
export async function clipboardRead(): Promise<string> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return (await readText()) ?? '';
    }
    if (isAndroidApp) return (await SinosMobile.clipboardRead()).value;
    return await navigator.clipboard.readText();
  } catch { return ''; }
}

/** Read an image from the OS clipboard and persist it as a PNG temp file,
 *  returning the absolute path. Returns null when the clipboard holds no
 *  image (or the clipboard is temporarily locked) — callers fall back to
 *  `clipboardRead()` for the text-paste path. Goes through the Tauri
 *  backend (arboard), so unlike `navigator.clipboard.read()` it never
 *  triggers a WebView2 permission prompt. */
export async function clipboardReadImage(): Promise<string | null> {
  try { return (await clipboardReadImages())[0] ?? null; }
  catch { return null; }
}

/** Metadata probe for right-click image priority; errors must not overwrite the clipboard. */
export async function clipboardHasImage(): Promise<boolean> {
  if (!('__TAURI_INTERNALS__' in window)) return false;
  const { commands } = await import('../tauri');
  return commands.clipboardHasImage();
}

/** Screenshot PNG or copied image files. Keep errors visible to paste UI. */
export async function clipboardReadImages(): Promise<string[]> {
  if (!('__TAURI_INTERNALS__' in window)) return [];
  const { commands } = await import('../tauri');
  return commands.readClipboardImages();
}
