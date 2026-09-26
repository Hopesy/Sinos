// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { selectedSurfaceText, useTerminalContextMenu } from './useTerminalContextMenu';
import { TermContextMenu, type TermContextMenuState } from './TermContextMenu';
import { createCodexTerminalSelection } from '../../lib/codex-terminal-selection';
const copy = vi.hoisted(() => vi.fn());
const hasImage = vi.hoisted(() => vi.fn());
vi.mock('../../lib/clipboard', () => ({ clipboardWrite: copy, clipboardHasImage: hasImage }));
vi.mock('../../i18n/useT', () => ({ useT: () => (key: string) => key }));
afterEach(() => { cleanup(); copy.mockReset(); window.getSelection()?.removeAllRanges(); });
beforeEach(() => { hasImage.mockReset().mockResolvedValue(false); });
function Harness({ read, application }: { read: () => string; application?: () => (() => Promise<void>) | undefined }) {
  const [menu, setMenu] = useState<TermContextMenuState | null>(null);
  const { contextMenuHandlers, copyMenuSelection, closeMenu } = useTerminalContextMenu(read, setMenu, application);
  return <div {...contextMenuHandlers}>
    <div data-testid="terminal" /><output>{menu ? JSON.stringify(menu) : 'closed'}</output>
    {menu && <TermContextMenu menu={menu} onCopy={() => copyMenuSelection(menu)} onClose={closeMenu} onPaste={closeMenu} onSelectAll={closeMenu} />}
  </div>;
}
it('copies a Codex-owned selection and keeps its menu enabled after Codex clears the selection', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  const selection = createCodexTerminalSelection(() => true, write);
  selection.observe('\x1b[<0;3;12M\x1b[<32;18;12M\x1b[<0;18;12m');
  const view = render(<Harness read={() => ''} application={selection.read} />), terminal = view.getByTestId('terminal');
  fireEvent.mouseDown(terminal, { button: 2 });
  await waitFor(() => expect(selection.read()).toBeUndefined());
  fireEvent.contextMenu(terminal, { button: 2 });
  expect(write).toHaveBeenCalledExactlyOnceWith('\x1b[<2;3;12M\x1b[<2;3;12m');
  expect(copy).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: /menu.copy/ }).hasAttribute('disabled')).toBe(false);
  expect(view.getByRole('button', { name: /menu.paste/ })).toBeTruthy();
  expect(view.getByRole('button', { name: /menu.select_all/ })).toBeTruthy();
});
it('enables the menu copy action for a Codex selection and still prioritizes a native xterm selection', async () => {
  copy.mockResolvedValue(undefined);
  const delegated = vi.fn().mockResolvedValue(undefined);
  const view = render(<Harness read={() => ''} application={() => delegated} />);
  fireEvent.contextMenu(view.getByTestId('terminal'), { button: 0 });
  expect(view.getByRole('button', { name: /menu.copy/ }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(view.getByText('menu.copy'));
  expect(delegated).toHaveBeenCalledOnce();
  view.rerender(<Harness read={() => 'Shift-drag native selection'} application={() => delegated} />);
  fireEvent.mouseDown(view.getByTestId('terminal'), { button: 2 });
  await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith('Shift-drag native selection', { throwOnError: true }));
  expect(delegated).toHaveBeenCalledOnce();
});
it('copies on right-button press even when the WebView does not deliver a contextmenu event', async () => {
  copy.mockResolvedValue(undefined);
  const view = render(<Harness read={() => 'selected before focus changes'} />);
  fireEvent.mouseDown(view.getByTestId('terminal'), { button: 2 });
  await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith('selected before focus changes', { throwOnError: true }));
});
it('captures on pointerdown before a native pointer handler can clear the selection', async () => {
  copy.mockResolvedValue(undefined);
  let text = 'pointer selection';
  const view = render(<Harness read={() => text} />), terminal = view.getByTestId('terminal');
  const native = vi.fn(() => { text = ''; });
  terminal.addEventListener('pointerdown', native);
  // jsdom has no PointerEvent constructor; the fields used here are shared with MouseEvent.
  fireEvent(terminal, new MouseEvent('pointerdown', { button: 2, bubbles: true, cancelable: true }));
  text = '';
  fireEvent.mouseDown(terminal, { button: 2 });
  fireEvent.contextMenu(terminal, { button: 2 });
  await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith('pointer selection', { throwOnError: true }));
  expect(native).not.toHaveBeenCalled();
});
it('supports button activation by click/keyboard and never pastes on a right-button press', () => {
  const onCopy = vi.fn(), onPaste = vi.fn();
  const view = render(<TermContextMenu menu={{ x: 0, y: 0, hasSelection: true, text: 'snapshot' }} onClose={vi.fn()} onCopy={onCopy} onPaste={onPaste} onSelectAll={vi.fn()} />);
  fireEvent.mouseDown(view.getByText('menu.paste'), { button: 2 });
  expect(onPaste).not.toHaveBeenCalled();
  fireEvent.click(view.getByText('menu.copy'), { detail: 0 });
  expect(onCopy).toHaveBeenCalledOnce();
});
it('auto-copies once and leaves a working menu with the original text after xterm repaints', async () => {
  copy.mockResolvedValue(undefined);
  let text = '第一行\n  second line';
  const view = render(<Harness read={() => text} />), terminal = view.getByTestId('terminal');
  const native = vi.fn(() => { text = ''; });
  terminal.addEventListener('mousedown', native); terminal.addEventListener('contextmenu', native);
  fireEvent.mouseDown(terminal, { button: 2 });
  text = ''; // An asynchronous output repaint may also clear the highlight.
  fireEvent.contextMenu(terminal, { button: 2 });
  await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith('第一行\n  second line', { throwOnError: true }));
  expect(native).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: /menu.copy/ }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(view.getByText('menu.copy'));
  expect(copy).toHaveBeenCalledTimes(2);
  expect(copy).toHaveBeenLastCalledWith('第一行\n  second line', { throwOnError: true });
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
it('retries from the menu with the original text after a repaint, including repeated clipboard failures', async () => {
  copy.mockRejectedValueOnce(new Error('busy')).mockRejectedValueOnce(new Error('still busy')).mockResolvedValue(undefined);
  let text = '原始选区\n  const value = 1;';
  const view = render(<Harness read={() => text} />), terminal = view.getByTestId('terminal');
  fireEvent.mouseDown(terminal, { button: 2 });
  text = '';
  fireEvent.contextMenu(terminal, { button: 2 });
  await waitFor(() => expect(copy).toHaveBeenCalledOnce());
  await waitFor(() => expect(view.getByRole('button', { name: /menu.copy/ }).hasAttribute('disabled')).toBe(false));
  // A portaled menu is still a React descendant of the terminal wrapper.
  fireEvent.mouseDown(view.getByText('menu.copy'), { button: 0 });
  fireEvent.click(view.getByText('menu.copy'));
  await waitFor(() => expect(view.getByRole('button', { name: /menu.copy/ }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(view.getByText('menu.copy'));
  expect(copy).toHaveBeenCalledTimes(3);
  expect(copy.mock.calls.every(([value]) => value === '原始选区\n  const value = 1;')).toBe(true);
  expect(view.getByRole('status').textContent).toBe('closed');
});
it('does not reopen an old failed copy menu after a new pointer gesture', async () => {
  let reject!: (error: Error) => void;
  copy.mockReturnValue(new Promise<void>((_resolve, fail) => { reject = fail; }));
  const view = render(<Harness read={() => 'old selection'} />), terminal = view.getByTestId('terminal');
  fireEvent.mouseDown(terminal, { button: 2 });
  fireEvent.contextMenu(terminal, { button: 2 });
  await waitFor(() => expect(copy).toHaveBeenCalledOnce());
  fireEvent.mouseDown(terminal, { button: 0 });
  reject(new Error('busy'));
  await waitFor(() => expect(view.getByRole('status').textContent).toBe('closed'));
});
it('opens a keyboard copy menu after an unfinished pointer gesture without copying again', async () => {
  copy.mockResolvedValue(undefined);
  const view = render(<Harness read={() => 'selected'} />), terminal = view.getByTestId('terminal');
  fireEvent.mouseDown(terminal, { button: 2 });
  await waitFor(() => expect(copy).toHaveBeenCalledOnce());
  fireEvent.keyDown(terminal, { key: 'F10', shiftKey: true });
  fireEvent.contextMenu(terminal, { button: 0 });
  expect(copy).toHaveBeenCalledOnce();
  expect(view.getByRole('button', { name: /menu.copy/ }).hasAttribute('disabled')).toBe(false);
});
it.each([false, true])('preserves clipboard images before automatic text or Codex copying (Codex=%s)', async application => {
  hasImage.mockResolvedValue(true); copy.mockResolvedValue(undefined);
  const nativeCopy = vi.fn().mockResolvedValue(undefined);
  const view = render(<Harness read={() => application ? '' : 'selected text'} application={application ? () => nativeCopy : undefined} />);
  fireEvent.mouseDown(view.getByTestId('terminal'), { button: 2 });
  fireEvent.contextMenu(view.getByTestId('terminal'), { button: 2 });
  await waitFor(() => expect(view.getByText('menu.paste_image')).toBeTruthy());
  expect(copy).not.toHaveBeenCalled(); expect(nativeCopy).not.toHaveBeenCalled();
  // A deliberate menu Copy still overrides the clipboard when requested.
  fireEvent.click(view.getByText('menu.copy'));
  expect(application ? nativeCopy : copy).toHaveBeenCalledOnce();
});
it('does not auto-copy after the user dismisses the menu while the clipboard probe is pending', async () => {
  let resolve!: (value: boolean) => void;
  hasImage.mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
  const view = render(<Harness read={() => 'selected'} />);
  fireEvent.mouseDown(view.getByTestId('terminal'), { button: 2 });
  fireEvent.click(view.getByText('menu.paste'));
  resolve(false);
  await waitFor(() => expect(view.getByRole('status').textContent).toBe('closed'));
  expect(copy).not.toHaveBeenCalled();
});
it('does not copy DOM selections belonging to another panel', () => {
  const view = render(<div><div data-testid="ours">ours</div><div data-testid="other">other</div></div>);
  const range = document.createRange(); range.selectNodeContents(view.getByTestId('other')); window.getSelection()?.addRange(range);
  expect(selectedSurfaceText(view.getByTestId('ours'))).toBe('');
  expect(selectedSurfaceText(view.getByTestId('other'))).toBe('other');
});
