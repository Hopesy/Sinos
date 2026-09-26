import { expect, it, vi } from 'vitest';
import { IMAGE_CHUNK, imageMessage, imagePrompt, imageProjection, prepareImage, sameImagePrompt, uploadImage } from './images';
import { mergeConversationTimeline, projectConversation } from './conversationProjection';
import { RemoteClient, RemoteError } from './client';
import type { ImageAttachment } from './types';

const meta: ImageAttachment = { id: 'image', name: 'screen.png', reference: 'C:\\Temp\\sinos-mobile-images\\screen.png', size: 10, width: 10, height: 10 };
it('hides only exact known attachment references and preserves other file paths', () => {
  const prompt = imagePrompt('调整布局', [meta]);
  expect(imageMessage(prompt, [meta])).toEqual({ text: '调整布局', images: [meta] });
  expect(imageMessage(prompt, []).text).toBe(prompt);
  expect(imageMessage(prompt + '\n- C:\\other.png', [meta]).images).toHaveLength(0);
  expect(imagePrompt('', [meta])).toContain('请参考这些图片。');
});

it('recognizes known image envelopes without relying on terminal line breaks', () => {
  const second = { ...meta, id: 'second', reference: 'C:\\Temp\\sinos-mobile-images\\second.png' };
  const images = [meta, second], text = '第一行\n第二行';
  const prompt = imagePrompt(text, images), flattened = prompt.replace(/\n/g, '');
  for (const echo of [prompt, flattened, prompt.replace(/\n/g, '\r\n'), flattened.replace(/C:\\/g, '\\\\?\\C:\\'), flattened.replace(/\\/g, '/')]) {
    expect(imageMessage(echo, images).images).toEqual(images);
    expect(sameImagePrompt(prompt, echo, images)).toBe(true);
  }
  for (const echo of [flattened + '- ', flattened + '- C:\\unknown.png', flattened + ' additional prose']) {
    expect(imageMessage(echo, images).images).toEqual([]);
    expect(sameImagePrompt(prompt, echo, images)).toBe(false);
  }
  expect(sameImagePrompt(prompt, imagePrompt(text, [second, meta]), images)).toBe(false);
  expect(sameImagePrompt('a b', 'ab', images)).toBe(false);
});
it('uploads bounded chunks and resumes a timed-out upload from the desktop offset', async () => {
  const blob = new Blob([new Uint8Array(IMAGE_CHUNK * 2 + 40)]);
  const image = { id: 'image', name: 'screen.png', blob };
  let received = 0, failed = false;
  const request = vi.fn(async (_session: string, value: { action: string; offset?: number; data_base64?: string }) => {
    if (value.action === 'status') return { received, image: null };
    expect(value.offset).toBe(received);
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(1048576 - 1024);
    received += atob(value.data_base64!).length;
    if (!failed) { failed = true; throw new Error('timeout after stored'); }
    return { received, image: received === blob.size ? { ...meta, size: blob.size } : null };
  });
  const client = { images: request } as unknown as RemoteClient;
  const progress = vi.fn();
  await expect(uploadImage(client, 'session', image, new AbortController().signal, progress)).rejects.toThrow('timeout');
  expect(received).toBe(IMAGE_CHUNK);
  expect((await uploadImage(client, 'session', image, new AbortController().signal, progress)).size).toBe(blob.size);
  expect(request.mock.calls.filter(call => call[1].action === 'upload').map(call => call[1].offset)).toEqual([0, IMAGE_CHUNK, IMAGE_CHUNK * 2]);
  expect(progress).toHaveBeenLastCalledWith(1);
});
it('does not start a transfer after cancellation and rejects inconsistent upload acknowledgements', async () => {
  const client = { images: vi.fn().mockResolvedValue({ received: 0, image: null }) } as unknown as RemoteClient;
  const draft = { id: 'image', name: 'screen.png', blob: new Blob(['x']) };
  const controller = new AbortController(); controller.abort();
  await expect(uploadImage(client, 'session', draft, controller.signal, vi.fn())).rejects.toThrow('IMAGE_CANCELLED');
  expect(client.images).toHaveBeenCalledTimes(1);
  vi.mocked(client.images).mockRejectedValueOnce(new RemoteError(404, 'IMAGE_NOT_FOUND')).mockResolvedValue({ received: 0, image: null });
  await expect(uploadImage(client, 'session', draft, new AbortController().signal, vi.fn())).rejects.toThrow('IMAGE_OFFSET');
});
it('rejects active content and oversized files before attempting to decode them', async () => {
  await expect(prepareImage(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))).rejects.toThrow('INVALID_IMAGE');
  await expect(prepareImage(new File([new Uint8Array(21 * 1024 * 1024)], 'x.png', { type: 'image/png' }))).rejects.toThrow('IMAGE_TOO_LARGE');
});

it('merges the terminal image footer once while preserving independent assistant paths', () => {
  for (const text of ['调整布局', '调整布局\n\n保持当前配色']) {
    const prompt = imagePrompt(text, [meta]);
    const projected = projectConversation([`› ${prompt}`, '完成。'].join('\n\n').split('\n'));
    const native = [{ id: 'user', role: 'user' as const, content: prompt }, { id: 'assistant', role: 'assistant' as const, content: '完成。' }];
    expect(mergeConversationTimeline(imageProjection(projected, [prompt], [meta]), native)).toEqual(native.map(message => ({ source: 'message', message })));
  }
  const separate = projectConversation(['› 不带附件的问题', '', '这是电脑上的文件。', '', '参考图片：', `- ${meta.reference}`]);
  expect(imageProjection(separate, [], [meta])).toEqual(separate);
  const noHistory = projectConversation([`› ${imagePrompt('', [meta])}`].join('').split('\n'));
  expect(imageProjection(noHistory, [], [meta]).events).toHaveLength(1);
});

it('folds flat and split terminal image echoes into the pending message once', () => {
  const prompt = imagePrompt('第一行\n第二行', [meta]);
  const pending = { id: 'pending-1', role: 'user' as const, content: prompt };
  const compact = { events: [{ id: 'user', kind: 'user' as const, text: prompt.replace(/\n/g, '') }], question: null };
  expect(mergeConversationTimeline(imageProjection(compact, [prompt], [meta]), [pending])).toEqual([{ source: 'message', message: pending }]);
  const split = { events: [
    { id: 'user', kind: 'user' as const, text: '第一行第二行' },
    { id: 'header', kind: 'assistant' as const, text: '参考图片：' },
    { id: 'path', kind: 'assistant' as const, text: `- ${meta.reference}` },
  ], question: null };
  expect(mergeConversationTimeline(imageProjection(split, [prompt], [meta]), [pending])).toEqual([{ source: 'message', message: pending }]);
});
