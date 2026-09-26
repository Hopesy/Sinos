// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';
import { RemoteClient, RemoteError } from './client';
import type { ImageAttachment, QueuedPrompt } from './types';
import { imagePrompt, loadImageDraft, saveImageDraft, prepareImage } from './images';
import type { CodexLive } from './CodexEventStream';
import type { ClaudeLive } from './ClaudeEventStream';

const live = vi.hoisted(() => ({ projection: { events: [], question: null }, stream: 'live', codex: { available: false, messages: [] } as CodexLive, claude: { available: false, turns: [] } as ClaudeLive }));
vi.mock('./useConversationStream', () => ({ useConversationStream: () => live }));
vi.mock('./images', async original => ({ ...await original<typeof import('./images')>(), loadImageDraft: vi.fn(), saveImageDraft: vi.fn(), prepareImage: vi.fn() }));
const session = { id: 'image-chat', tool: 'claude', cwd: '/project', running: true, paused: false, cols: 80, rows: 24, output_chunks: 0, activity: { state: 'idle' as 'idle' | 'working', source: 'native_log', revision: 1, auto_send_ready: false } };
let images: ImageAttachment[], messages: QueuedPrompt[], failUpload: boolean;
const client = { chat: vi.fn(), prompt: vi.fn(), queue: vi.fn(), queueAction: vi.fn(), images: vi.fn() } as unknown as RemoteClient;
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: function(this: Blob) { return new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(this); }); } });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }));
  vi.mocked(loadImageDraft).mockReset().mockResolvedValue([]); vi.mocked(saveImageDraft).mockReset().mockResolvedValue(undefined);
  vi.mocked(prepareImage).mockReset().mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  images = []; messages = []; failUpload = false;
  session.tool = 'claude'; live.codex = { available: false, messages: [] }; live.claude = { available: false, turns: [] }; live.stream = 'live';
  session.activity.state = 'idle';
  vi.mocked(client.chat).mockReset().mockResolvedValue({ bound: false, data: '', cursor: 0, history_cursor: 0, revision: '', append: false, prepend: false, unchanged: false, has_older: false, sourceId: '' });
  vi.mocked(client.prompt).mockReset().mockResolvedValue(undefined);
  vi.mocked(client.queue).mockReset().mockImplementation(async () => ({ messages, activity: session.activity }));
  vi.mocked(client.queueAction).mockReset().mockImplementation(async (_session, _action, id, text, _revision, ids) => { messages = [{ id, text: text || '', revision: 1, status: 'queued', attachments: images.filter(image => ids?.includes(image.id)) }]; return { messages, activity: session.activity }; });
  vi.mocked(client.images).mockReset().mockImplementation(async (_session, raw) => {
    const request = raw as { action: string; id: string; name: string; total: number };
    if (request.action === 'list') return { images };
    if (request.action === 'preview') return { data_base64: 'aW1hZ2U=' };
    if (request.action === 'status') { const image = images.find(item => item.id === request.id); if (image) return { received: image.size, image }; throw new RemoteError(404, 'IMAGE_NOT_FOUND'); }
    if (request.action === 'upload') {
      if (failUpload) throw new RemoteError(503, 'COMPUTER_OFFLINE');
      const image = { id: request.id, name: request.name, size: request.total, width: 10, height: 10, reference: `C:/Temp/${request.id}.png` };
      images.push(image); return { received: request.total, image };
    }
    return { removed: true };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount() {
  const view = render(<ChatView client={client} session={session} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} capabilities={['image_attachments_v1', 'message_queue']} />);
  await act(async () => {}); return view;
}
async function choose() {
  await act(async () => fireEvent.change(screen.getByLabelText('选择图片文件'), { target: { files: [new File(['image'], '参考图.png', { type: 'image/png' })] } }));
}
it('sends an image-only message and shows its preview without leaking the local path into the bubble', async () => {
  await mount(); await choose();
  expect(screen.getByRole('button', { name: '移除图片：参考图.png' })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^发送$/ })));
  await waitFor(() => expect(client.prompt).toHaveBeenCalledTimes(1));
  expect(client.prompt).toHaveBeenCalledExactlyOnceWith(session.id, '', [images[0].id]);
  expect(screen.getByRole('button', { name: '查看图片：参考图.png' })).toBeTruthy();
  expect(screen.queryByText(/C:\/Temp/)).toBeNull();
  expect(screen.queryByRole('button', { name: '移除图片：参考图.png' })).toBeNull();
  expect(saveImageDraft).toHaveBeenLastCalledWith(session.id, []);
});

it.each(['claude', 'codex'])('reconciles a flattened %s image echo across streaming, history and reload', async tool => {
  session.tool = tool;
  const props = { client, session, online: true, toolName: tool, onTitle: vi.fn(), insert: '', onInserted: vi.fn(), capabilities: ['image_attachments_v1'] };
  const view = render(<ChatView {...props} />); await act(async () => {}); await choose();
  fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '看看这张照片\n说明画面内容' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^发送$/ })));
  await waitFor(() => expect(client.prompt).toHaveBeenCalledTimes(1));
  expect(view.container.querySelectorAll('article.user')).toHaveLength(1);
  expect(screen.getByText('等待终端确认')).toBeTruthy();
  // Same shape as a Windows Codex rollout: LF removed, absolute path retained.
  const echo = imagePrompt('看看这张照片\n说明画面内容', images).replace(/\n/g, '').replace(/C:\//g, '\\\\?\\C:\\').replace(/\//g, '\\');
  const reply = { id: 'answer', role: 'assistant' as const, content: '图片分析完成。' };
  if (tool === 'claude') live.claude = { available: true, threadId: 'image-thread', turns: [{ id: 'turn', prompt: echo, complete: true, messages: [reply] }], activity: 'idle' };
  else live.codex = { available: true, threadId: 'image-thread', messages: [{ id: 'live-user', role: 'user', content: echo }, reply], status: {}, activity: 'idle' };
  view.rerender(<ChatView {...props} />);
  expect(view.container.querySelectorAll('article.user')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '查看图片：参考图.png' })).toHaveLength(1);
  expect(screen.queryByText('等待终端确认')).toBeNull();
  expect(screen.queryByText('等待终端响应')).toBeNull();
  expect(view.container.querySelector('.chat-timeline')?.textContent).not.toContain('参考图片：');
  const nativePrompt = imagePrompt('看看这张照片\n说明画面内容', images);
  const data = tool === 'claude' ? [
    { uuid: 'disk-user', message: { role: 'user', content: nativePrompt } },
    { uuid: 'answer', message: { role: 'assistant', content: reply.content } },
  ] : [
    { type: 'response_item', payload: { id: 'disk-user', type: 'message', role: 'user', content: [{ type: 'input_text', text: nativePrompt }] } },
    { type: 'response_item', payload: { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply.content }] } },
  ];
  vi.mocked(client.chat).mockResolvedValue({ bound: true, data: data.map(row => JSON.stringify(row)).join('\n') + '\n', cursor: 100, history_cursor: 0, revision: '1', append: false, prepend: false, unchanged: false, has_older: false, sourceId: `${tool}_native_image-thread` });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(view.container.querySelectorAll('article.user')).toHaveLength(1);
  expect(screen.queryByText('等待终端响应')).toBeNull();
  view.unmount(); live.codex = { available: false, messages: [] }; live.claude = { available: false, turns: [] };
  const restored = render(<ChatView {...props} />); await act(async () => {});
  expect(restored.container.querySelectorAll('article.user')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '查看图片：参考图.png' })).toHaveLength(1);
  expect(restored.container.querySelector('.chat-timeline')?.textContent).not.toContain('参考图片：');
  expect(screen.queryByText('等待终端响应')).toBeNull();
  expect(client.prompt).toHaveBeenCalledTimes(1);
});
it('retains image and text drafts when upload fails and sends only after the explicit retry', async () => {
  await mount(); await choose(); failUpload = true;
  fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '按照图片调整' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^发送$/ })));
  expect(client.prompt).not.toHaveBeenCalled();
  expect((await screen.findByRole('alert')).textContent).toContain('图片和草稿已保留');
  expect(screen.getByRole('button', { name: '移除图片：参考图.png' })).toBeTruthy();
  expect((screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement).value).toBe('按照图片调整');
  failUpload = false;
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^发送$/ })));
  await waitFor(() => expect(client.prompt).toHaveBeenCalledTimes(1));
  expect(client.prompt).toHaveBeenCalledExactlyOnceWith(session.id, '按照图片调整', [images[0].id]);
});
it('queues an image-only follow-up and preserves its attachment metadata', async () => {
  session.activity.state = 'working'; await mount(); await choose();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '加入队列' })));
  await waitFor(() => expect(client.queueAction).toHaveBeenCalledTimes(1));
  expect(client.prompt).not.toHaveBeenCalled();
  expect(client.queueAction).toHaveBeenCalledWith(session.id, 'enqueue', expect.any(String), '', undefined, [images[0].id]);
  expect(screen.getByText('待发送 · 1')).toBeTruthy();
  expect(screen.getByText('1 张图片 · 参考图.png')).toBeTruthy();
});
it('restores draft image blobs after reload and removes them without sending a prompt', async () => {
  vi.mocked(loadImageDraft).mockResolvedValue([{ id: 'restored', name: '草稿.png', blob: new Blob(['image']) }]);
  await mount();
  expect(screen.getByRole('button', { name: '预览图片：草稿.png' })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '移除图片：草稿.png' })));
  expect(saveImageDraft).toHaveBeenLastCalledWith(session.id, []);
  expect(client.prompt).not.toHaveBeenCalled();
});
it('does not submit when the desktop starts a turn during a slow upload', async () => {
  let finishUpload!: (value: unknown) => void;
  const initialImages = vi.mocked(client.images).getMockImplementation()!;
  vi.mocked(client.images).mockImplementation(async (...args) => {
    if ((args[1] as { action: string }).action !== 'upload') return initialImages(...args);
    return new Promise(resolve => { finishUpload = resolve; });
  });
  const view = await mount(); await choose();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^发送$/ })));
  await waitFor(() => expect(finishUpload).toBeTypeOf('function'));
  const request = vi.mocked(client.images).mock.calls.find(call => (call[1] as { action: string }).action === 'upload')![1] as { id: string; name: string; total: number };
  session.activity.state = 'working';
  view.rerender(<ChatView client={client} session={session} online toolName="Claude Code" onTitle={vi.fn()} insert="" onInserted={vi.fn()} capabilities={['image_attachments_v1', 'message_queue']} />);
  await act(async () => finishUpload({ received: request.total, image: { ...request, size: request.total, width: 10, height: 10, reference: 'C:/Temp/slow.png' } }));
  expect(client.prompt).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('当前会话仍在处理');
  expect(screen.getByRole('button', { name: '移除图片：参考图.png' })).toBeTruthy();
});
