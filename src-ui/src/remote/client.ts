import type { Changes, FileDiff, FileEntry, FileSnapshot, RemoteState, RemoteTool, QueueSnapshot } from './types';

export class RemoteError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function errorMessage(error: unknown): string {
  if (error instanceof RemoteError) {
    if (error.message === 'UNKNOWN_ACTION') return '电脑端暂不支持此操作，请更新电脑端后再试。';
    if (error.message === 'STALE_INTERACTION') return '这条确认已更新，请查看最新提示后重新选择。';
    if (error.message === 'SESSION_BUSY') return '当前会话仍在处理或等待确认，请稍后发送或加入队列。';
    if (error.message === 'QUEUE_CONFLICT' || error.message === 'MESSAGE_NOT_FOUND') return '这条排队消息已发生变化，请查看最新队列。';
    if (error.message === 'QUEUE_FULL') return '待发送消息已满，请先处理或删除部分消息。';
    if (error.message === 'DELIVERY_UNCERTAIN') return '无法确认消息是否送达，已暂停自动发送。请查看对话后再决定是否重新发送。';
    if (error.message === 'CONNECTION_REPLACED') return '已在另一个页面连接，可切回此页面继续。';
    if (error.status === 401) return '配对已失效，请在电脑上生成新的配对链接。';
    if (error.status === 409) return '文件已在电脑端发生变化。你的修改已保留，请重新载入后合并。';
    if (error.status === 404) return '会话或文件已不存在，请刷新后重试。';
    if (error.status === 413) return '内容超出单次传输上限，请在电脑端查看或缩小修改范围。';
    if (error.status === 503) return '电脑暂时离线，连接恢复后再试。';
    if (/TOO_LARGE/.test(error.message)) return '文件超过 512 KB，请在电脑端打开。';
    if (/BINARY|ENCODING/.test(error.message)) return '这个文件不是 UTF-8 文本，请在电脑端打开。';
    if (/OUTSIDE_WORKSPACE/.test(error.message)) return '只能访问当前会话项目内的文件。';
    if (error.message === 'CWD_NOT_DIRECTORY') return '这个路径是文件，请指定一个文件夹。';
    if (error.message.startsWith('CWD_CREATE_FAILED')) return '无法创建文件夹，请检查路径和电脑上的目录权限。';
    if (/cwd/i.test(error.message)) return '无法使用这个工作目录，请检查电脑上的项目路径。';
    return '操作未完成，请重试。';
  }
  return '连接暂时中断，请保持电脑运行，连接恢复后再试。';
}

export interface RemoteSocket {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

// Native shells can inject their server URL and secure-store credential.
export class RemoteClient {
  readonly baseUrl: string;
  readonly token: string;
  constructor(baseUrl: string, token: string) { this.baseUrl = baseUrl; this.token = token; }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) controller.abort();
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        ...init, signal: controller.signal, cache: 'no-store',
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
      if (!response.ok) throw new RemoteError(response.status, (await response.text()).slice(0, 500));
      return response.status === 204 ? undefined as T : await response.json() as T;
    } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
  }
  sessionPath(id: string, action: string, path?: string) {
    return `/api/sessions/${encodeURIComponent(id)}/${action}${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`;
  }
  state(signal?: AbortSignal) { return this.request<RemoteState>('/api/state', { signal }); }
  tools(signal?: AbortSignal) { return this.request<RemoteTool[]>('/api/tools', { signal }); }
  launch(tool: string, cwd: string) { return this.request<{ session_id: string }>('/api/launch', { method: 'POST', body: JSON.stringify({ tool, cwd: cwd || undefined }) }); }
  input(id: string, data: string) { return this.request<void>(this.sessionPath(id, 'input'), { method: 'POST', body: JSON.stringify({ data }) }); }
  prompt(id: string, data: string, attachments?: string[]) { return this.request<void>(this.sessionPath(id, 'prompt'), { method: 'POST', body: JSON.stringify({ data, attachments }) }); }
  images<T>(id: string, params: object, signal?: AbortSignal) { return this.request<T>(this.sessionPath(id, 'images'), { method: 'POST', body: JSON.stringify(params), signal }); }
  answer(id: string, data: string, expectedOutput: number, kind?: 'text') { return this.request<void>(this.sessionPath(id, 'answer'), { method: 'POST', body: JSON.stringify({ data, expected_output: expectedOutput, kind }) }); }
  queue(id: string, signal?: AbortSignal) { return this.request<QueueSnapshot>(this.sessionPath(id, 'queue'), { signal }); }
  queueAction(id: string, action: 'enqueue' | 'edit' | 'remove' | 'send' | 'hold' | 'release', messageId: string, text = '', expectedRevision?: number, attachments?: string[]) { return this.request<QueueSnapshot>(this.sessionPath(id, 'queue'), { method: 'POST', body: JSON.stringify({ action, id: messageId, text, expected_revision: expectedRevision, attachments }) }); }
  pause(id: string, paused: boolean) { return this.request<void>(this.sessionPath(id, 'pause'), { method: 'POST', body: JSON.stringify({ paused }) }); }
  kill(id: string) { return this.request<void>(this.sessionPath(id, 'kill'), { method: 'POST' }); }
  chat(id: string, cursor?: number | null, revision?: string, before?: number) {
    const query = new URLSearchParams();
    if (cursor != null) query.set('cursor', String(cursor));
    if (revision) query.set('revision', revision);
    if (before != null) query.set('before', String(before));
    return this.request<ChatRead>(`${this.sessionPath(id, 'chat')}?${query}`);
  }
  directory(id: string, path: string) { return this.request<{ entries: FileEntry[]; truncated: boolean }>(this.sessionPath(id, 'directory', path)); }
  file(id: string, path: string) { return this.request<FileSnapshot>(this.sessionPath(id, 'file', path)); }
  save(id: string, path: string, content: string, file: FileSnapshot) {
    return this.request<{ revision: string; size: number }>(this.sessionPath(id, 'file', path), { method: 'POST', body: JSON.stringify({ content, expected_revision: file.revision, line_ending: file.line_ending, has_utf8_bom: file.has_utf8_bom }) });
  }
  changes(id: string) { return this.request<Changes>(this.sessionPath(id, 'changes')); }
  diff(id: string, path: string) { return this.request<FileDiff>(this.sessionPath(id, 'diff', path)); }
  socket(id: string): RemoteSocket {
    const url = new URL('/api/ws', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session_id', id);
    if (this.token) url.searchParams.set('token', this.token);
    return new WebSocket(url);
  }
}

export interface ChatRead { bound: boolean; title?: string; cwd?: string; sourceId?: string; data: string; cursor: number | null; history_cursor: number | null; has_older: boolean; revision: string; append: boolean; prepend: boolean; unchanged: boolean }

export function readPairingToken(): string {
  const pair = new URLSearchParams(window.location.hash.slice(1)).get('pair');
  if (pair) {
    try { localStorage.setItem('sinos-remote-token', pair); } catch { /* Connect even without storage. */ }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return pair;
  }
  try { return localStorage.getItem('sinos-remote-token') || ''; } catch { return ''; }
}

export function storageRead(key: string, fallback = '') { try { return localStorage.getItem(`sinos-mobile-${key}`) ?? fallback; } catch { return fallback; } }
export function storageWrite(key: string, value: string) { try { localStorage.setItem(`sinos-mobile-${key}`, value); } catch { /* Quota or private browsing. */ } }
export function projectName(cwd: string) { return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '工作区'; }
