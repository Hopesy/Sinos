// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { selectedSurfaceText, useTerminalContextMenu } from './useTerminalContextMenu';
import type { TermContextMenuState } from './TermContextMenu';
const copy = vi.hoisted(() => vi.fn());
vi.mock('../../lib/clipboard', () => ({ clipboardWrite: copy }));
afterEach(() => { cleanup(); copy.mockReset(); window.getSelection()?.removeAllRanges(); });
function Harness({ read }: { read: () => string }) {
  const [menu, setMenu] = useState<TermContextMenuState | null>(null);
  const handlers = useTerminalContextMenu(read, setMenu);
  return <div {...handlers}><div data-testid="terminal" /><output>{menu ? JSON.stringify(menu) : 'closed'}</output></div>;
}
it('copies once before xterm/native handlers can clear the selected text or send mouse input', () => {
  copy.mockResolvedValue(undefined);
  let text = '第一行\n  second line';
  const view = render(<Harness read={() => text} />), terminal = view.getByTestId('terminal');
  const native = vi.fn(() => { text = ''; });
  terminal.addEventListener('mousedown', native); terminal.addEventListener('contextmenu', native);
  fireEvent.mouseDown(terminal, { button: 2 });
  text = ''; // An asynchronous output repaint may also clear the highlight.
  fireEvent.contextMenu(terminal, { button: 2 });
  expect(copy).toHaveBeenCalledExactlyOnceWith('第一行\n  second line', { throwOnError: true });
  expect(native).not.toHaveBeenCalled();
  expect(view.getByRole('status').textContent).toBe('closed');
});
it('keeps the paste/select-all menu with no selection and snapshots keyboard-menu selections', () => {
  const view = render(<Harness read={() => ''} />);
  fireEvent.mouseDown(view.getByTestId('terminal'), { button: 2 });
  fireEvent.contextMenu(view.getByTestId('terminal'), { button: 2 });
  expect(copy).not.toHaveBeenCalled(); expect(view.getByRole('status').textContent).toContain('"hasSelection":false');
  view.rerender(<Harness read={() => 'keyboard selection'} />);
  fireEvent.contextMenu(view.getByTestId('terminal'), { button: 0 });
  expect(copy).not.toHaveBeenCalled(); expect(view.getByRole('status').textContent).toContain('"text":"keyboard selection"');
});
it('leaves primary-button dragging intact and offers an enabled copy retry on clipboard failure', async () => {
  copy.mockRejectedValue(new Error('busy'));
  const view = render(<Harness read={() => 'selected'} />), terminal = view.getByTestId('terminal');
  const native = vi.fn(); terminal.addEventListener('mousedown', native);
  fireEvent.mouseDown(terminal, { button: 0 }); expect(native).toHaveBeenCalledOnce();
  fireEvent.contextMenu(terminal, { button: 2 });
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('"hasSelection":true'));
});
it('does not copy DOM selections belonging to another panel', () => {
  const view = render(<div><div data-testid="ours">ours</div><div data-testid="other">other</div></div>);
  const range = document.createRange(); range.selectNodeContents(view.getByTestId('other')); window.getSelection()?.addRange(range);
  expect(selectedSurfaceText(view.getByTestId('ours'))).toBe('');
  expect(selectedSurfaceText(view.getByTestId('other'))).toBe('other');
});
