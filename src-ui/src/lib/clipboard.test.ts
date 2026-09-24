// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clipboardWrite, clipboardRead } from './clipboard';

const native = vi.hoisted(() => ({ writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue('desktop') }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => native);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

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
