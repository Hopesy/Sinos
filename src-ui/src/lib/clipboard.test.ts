// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clipboardWrite, clipboardRead, clipboardHasImage, clipboardReadImages } from './clipboard';

const native = vi.hoisted(() => ({ writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue('desktop') }));
const phone = vi.hoisted(() => ({ android: false, clipboardWrite: vi.fn().mockResolvedValue(undefined), clipboardRead: vi.fn().mockResolvedValue({ value: 'phone' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => native);
const images = vi.hoisted(() => ({ clipboardHasImage: vi.fn(), readClipboardImages: vi.fn() }));
vi.mock('../tauri', () => ({ commands: images }));
vi.mock('../remote/native/bridge', () => ({ get isAndroidApp() { return phone.android; }, SinosMobile: phone }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); phone.android = false; document.body.replaceChildren(); delete (document as unknown as Record<string, unknown>).execCommand; delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it('uses the native plugin on Tauri and never calls the browser clipboard', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const writeText = vi.fn();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await clipboardWrite('native');
  expect(native.writeText).toHaveBeenCalledWith('native');
  expect(writeText).not.toHaveBeenCalled();
  expect(await clipboardRead()).toBe('desktop');
});

it('writes in the browser and exposes failure only to callers requesting it', async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('denied'));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await clipboardWrite('browser', { throwOnError: true });
  expect(writeText).toHaveBeenCalledWith('browser');
  await expect(clipboardWrite('fail', { throwOnError: true })).rejects.toThrow('denied');
  await expect(clipboardWrite('legacy')).resolves.toBeUndefined();
  expect(native.writeText).not.toHaveBeenCalled();
});

it('starts the web write in the same synchronous click, before any await or lazy import', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const result = clipboardWrite('one tap', { throwOnError: true });
  expect(writeText).toHaveBeenCalledExactlyOnceWith('one tap');
  await result;
});

it.each([false, true])('copies within an open dialog when the browser API is unavailable/denied (%s)', async denied => {
  const readText = vi.fn();
  vi.stubGlobal('navigator', denied ? { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')), readText } } : {});
  const dialog = document.createElement('dialog'); dialog.open = true;
  const field = document.createElement('input'); field.value = 'owner draft'; dialog.appendChild(field); document.body.appendChild(dialog);
  field.focus(); field.setSelectionRange(1, 4);
  const exec = vi.fn(() => {
    const selected = document.activeElement as HTMLTextAreaElement;
    expect(selected.tagName).toBe('TEXTAREA'); expect(selected.parentElement).toBe(dialog);
    expect(selected.value).toBe('https://relay.test/#share=fixture');
    expect(selected.selectionStart).toBe(0); expect(selected.selectionEnd).toBe(selected.value.length);
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
  await clipboardWrite('https://relay.test/#share=fixture', { throwOnError: true });
  expect(exec).toHaveBeenCalledExactlyOnceWith('copy');
  expect(document.activeElement).toBe(field); expect(field.value).toBe('owner draft'); expect(field.selectionStart).toBe(1); expect(field.selectionEnd).toBe(4);
  expect(dialog.querySelector('textarea')).toBeNull(); expect(readText).not.toHaveBeenCalled();
});

it('uses the Android plugin exclusively and propagates native write failures', async () => {
  phone.android = true;
  const webWrite = vi.fn(), exec = vi.fn();
  vi.stubGlobal('navigator', { clipboard: { writeText: webWrite } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
  await clipboardWrite('android', { throwOnError: true });
  expect(phone.clipboardWrite).toHaveBeenCalledWith({ value: 'android' });
  expect(await clipboardRead()).toBe('phone');
  phone.clipboardWrite.mockRejectedValueOnce(new Error('native failure'));
  await expect(clipboardWrite('fail', { throwOnError: true })).rejects.toThrow('native failure');
  expect(webWrite).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
});

it('never reports successful copying when both browser paths fail', async () => {
  vi.stubGlobal('navigator', {});
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(false) });
  await expect(clipboardWrite('text', { throwOnError: true })).rejects.toThrow('CLIPBOARD_UNAVAILABLE');
  expect(document.querySelector('textarea')).toBeNull();
});

it('probes and reads screenshots/Explorer image files through native commands only', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const read = vi.fn(); vi.stubGlobal('navigator', { clipboard: { read } });
  images.clipboardHasImage.mockResolvedValue(true);
  images.readClipboardImages.mockResolvedValue(['C:\\截图 one.png', 'C:\\two.jpg']);
  expect(await clipboardHasImage()).toBe(true);
  expect(await clipboardReadImages()).toEqual(['C:\\截图 one.png', 'C:\\two.jpg']);
  expect(read).not.toHaveBeenCalled();
  images.readClipboardImages.mockRejectedValueOnce(new Error('IMAGE_TOO_LARGE'));
  await expect(clipboardReadImages()).rejects.toThrow('IMAGE_TOO_LARGE');
  images.clipboardHasImage.mockRejectedValueOnce(new Error('IMAGE_CLIPBOARD_BUSY'));
  await expect(clipboardHasImage()).rejects.toThrow('IMAGE_CLIPBOARD_BUSY');
});

it('never requests browser permission while probing a web context menu for images', async () => {
  const read = vi.fn(); vi.stubGlobal('navigator', { clipboard: { read } });
  expect(await clipboardHasImage()).toBe(false);
  expect(await clipboardReadImages()).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});
