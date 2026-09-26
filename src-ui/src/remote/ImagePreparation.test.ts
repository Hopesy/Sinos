// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareImage } from './images';

const decode = vi.fn(), draw = vi.fn();
let source = '';
beforeEach(() => {
  decode.mockReset().mockResolvedValue(undefined); draw.mockReset(); source = '';
  vi.stubGlobal('Image', class {
    naturalWidth = 4096; naturalHeight = 2048;
    set src(value: string) { source = value; }
    decode = decode;
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: draw }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback, type) { callback(new Blob(['reencoded'], { type })); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['image/png', 'image/jpeg', 'image/webp'])('prepares %s through a decoded object URL and bounded PNG re-encoding', async type => {
  const output = await prepareImage(new File(['fixture'], 'photo', { type }));
  expect(source).toBe('blob:test-image');
  expect(decode).toHaveBeenCalledOnce();
  expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 1024);
  expect(output.type).toBe('image/png');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(source);
});

it('cleans up object URLs after a genuine decode error', async () => {
  decode.mockRejectedValueOnce(new Error('bad bytes'));
  await expect(prepareImage(new File(['bad bytes'], 'photo.png', { type: 'image/png' }))).rejects.toThrow('INVALID_IMAGE');
  expect(draw).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(source);
});
