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

/** Tauri uses its native plugin; the phone uses the browser on an explicit tap.
 * Legacy callers remain best-effort. Callers showing a success message can
 * request rejection so a denied write is never presented as successful. */
export async function clipboardWrite(text: string, options?: { throwOnError: boolean }): Promise<void> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
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
  if (!('__TAURI_INTERNALS__' in window)) return null;
  try { const { commands } = await import('../tauri'); return await commands.readClipboardImage(); }
  catch { return null; }
}
