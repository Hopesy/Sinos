// Isolate mobile UI from desktop CSS and IPC.
const remote = !('__TAURI_INTERNALS__' in window) && /^\/remote(?:\/|$)/.test(window.location.pathname);
void (remote ? import('./remote/main') : import('./desktop'));
