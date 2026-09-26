import { beforeEach, expect, it, vi } from 'vitest';
import { createTerminalImageInput } from './terminal-image-input';

const clipboard = vi.hoisted(() => ({ clipboardRead: vi.fn(), clipboardReadImages: vi.fn() }));
const commands = vi.hoisted(() => ({ prepareImagePaths: vi.fn() }));
vi.mock('./clipboard', () => clipboard);
vi.mock('../tauri', () => ({ commands }));
beforeEach(() => {
  vi.resetAllMocks();
  clipboard.clipboardReadImages.mockResolvedValue([]);
  clipboard.clipboardRead.mockResolvedValue('plain\ntext');
  commands.prepareImagePaths.mockImplementation(async paths => paths);
});
function setup(tool = 'codex') {
  const target = { tool, isLive: vi.fn(() => true), bracketedPaste: vi.fn(() => true), settlePaste: vi.fn().mockResolvedValue(undefined), write: vi.fn().mockResolvedValue(undefined), pasteText: vi.fn(), notice: vi.fn() };
  return { ...target, input: createTerminalImageInput(target) };
}

it('pastes multiple images individually, quoting Unicode/spaced paths and never pressing Enter', async () => {
  const paths = ['C:\\截图 one.png', 'C:\\two.JPG'];
  clipboard.clipboardReadImages.mockResolvedValue([...paths, paths[0]]);
  const target = setup();
  await target.input.paste();
  expect(target.write.mock.calls).toEqual([
    ['\x1b[200~"C:\\截图 one.png" \x1b[201~'],
    ['\x1b[200~C:\\two.JPG \x1b[201~'],
  ]);
  expect(target.notice).toHaveBeenLastCalledWith({ kind: 'done', count: 2 });
  expect(clipboard.clipboardRead).not.toHaveBeenCalled();
  expect(target.pasteText).not.toHaveBeenCalled();
});

it('keeps normal text on xterm paste, including multiline text', async () => {
  const target = setup(); await target.input.paste();
  expect(target.pasteText).toHaveBeenCalledExactlyOnceWith('plain\ntext');
  expect(target.write).not.toHaveBeenCalled();
  expect(target.notice).toHaveBeenLastCalledWith(null);
});

it('separates Claude images inside bracketed paste so its debounce cannot glue quoted paths together', async () => {
  const target = setup('claude');
  await target.input.drop(['C:\\截图 one.png', 'C:\\截图 two.png']);
  expect(target.write).toHaveBeenCalledExactlyOnceWith('\x1b[200~"C:\\截图 one.png"\n"C:\\截图 two.png"\x1b[201~');
});

it('never sends a newline to Claude when bracketed paste is unavailable', async () => {
  const target = setup('claude'); target.bracketedPaste.mockReturnValue(false);
  await target.input.drop(['C:\\one.png', 'C:\\two.png']);
  expect(target.write.mock.calls).toEqual([['C:\\one.png '], ['C:\\two.png ']]);
});

it('waits for the previous Codex image paste to settle before writing the next', async () => {
  let finish!: () => void;
  const target = setup();
  target.settlePaste.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = target.input.drop(['C:\\one.png', 'C:\\two.png']);
  await vi.waitFor(() => expect(target.write).toHaveBeenCalledTimes(1));
  expect(target.input.busy).toBe(true);
  expect(target.notice).not.toHaveBeenCalledWith({ kind: 'done', count: 2 });
  finish(); await pending;
  expect(target.write).toHaveBeenCalledTimes(2);
  expect(target.settlePaste).toHaveBeenCalledTimes(2);
  expect(target.input.busy).toBe(false);
});

it('shows image errors instead of silently pasting alternate clipboard text', async () => {
  clipboard.clipboardReadImages.mockRejectedValue('IMAGE_CLIPBOARD_BUSY');
  const target = setup(); await target.input.paste();
  expect(clipboard.clipboardRead).not.toHaveBeenCalled();
  expect(target.write).not.toHaveBeenCalled();
  expect(target.notice).toHaveBeenLastCalledWith({ kind: 'error', error: 'IMAGE_CLIPBOARD_BUSY' });
  expect(target.input.busy).toBe(false);
});

it('validates a whole image drop before inserting anything', async () => {
  commands.prepareImagePaths.mockRejectedValue('IMAGE_FILE_UNAVAILABLE');
  const target = setup(); await target.input.drop(['C:\\valid.png', 'C:\\gone.png']);
  expect(target.write).not.toHaveBeenCalled();
  expect(target.notice).toHaveBeenLastCalledWith({ kind: 'error', error: 'IMAGE_FILE_UNAVAILABLE' });
});

it('rejects control characters in mixed drops before inserting the first path', async () => {
  const target = setup(); await target.input.drop(['C:\\valid.png', 'bad\ncommand.txt']);
  expect(target.write).not.toHaveBeenCalled();
  expect(target.notice).toHaveBeenLastCalledWith({ kind: 'error', error: 'Error: IMAGE_INVALID_PATH' });
});

it('keeps ordinary dropped files and supports terminals without bracketed paste', async () => {
  const target = setup(); target.bracketedPaste.mockReturnValue(false);
  await target.input.drop(['C:\\two.png', 'C:\\note.txt']);
  expect(target.write.mock.calls).toEqual([['C:\\two.png '], ['C:\\note.txt ']]);
  expect(commands.prepareImagePaths).toHaveBeenCalledWith(['C:\\two.png']);
});

it('does not paste into a closed terminal or start a duplicate concurrent paste', async () => {
  let finish!: (paths: string[]) => void;
  clipboard.clipboardReadImages.mockReturnValue(new Promise<string[]>(resolve => { finish = resolve; }));
  const target = setup(); const pending = target.input.paste();
  await target.input.paste();
  expect(clipboard.clipboardReadImages).toHaveBeenCalledTimes(1);
  target.isLive.mockReturnValue(false); finish(['C:\\one.png']); await pending;
  expect(target.write).not.toHaveBeenCalled();
  expect(target.pasteText).not.toHaveBeenCalled();
  expect(target.input.busy).toBe(false);
});
