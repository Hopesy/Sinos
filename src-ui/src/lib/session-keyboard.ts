/** Modal controls own keyboard events even when focus remains in the workspace. */
export function sessionKeyboardAllowed(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  const target = event.target instanceof Element ? event.target : null;
  return !target?.closest('[role="dialog"], [aria-modal="true"]')
    && !document.querySelector('[role="dialog"][aria-modal="true"]');
}
