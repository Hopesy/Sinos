// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteClient } from './client';
import { PhoneWorkspace } from './PhoneWorkspace';
import { CodexEventStream } from './CodexEventStream';
import type { ClaudeLive } from './ClaudeEventStream';
import type { CodexLive } from './CodexEventStream';
import type { ConversationProjection } from './conversationProjection';

const live = vi.hoisted(() => ({
  claude: { available: false, turns: [], cwd: '/Desktop/claude-project', status: { model: 'Opus', contextUsed: 18, lines: [] } } as ClaudeLive,
  codex: { available: false, messages: [] } as CodexLive,
  projection: { events: [], question: null, title: 'Claude project title' } as ConversationProjection,
}));
vi.mock('./useConnection', () => ({ useConnection: () => ({ state: {
  sessions: ['claude', 'codex'].map(tool => ({ id: tool, tool, cwd: '/Users/old-home', running: true, paused: false, cols: 100, rows: 30, output_chunks: 0 })),
  device_name: 'PC', default_cwd: '/Users/test/Desktop',
}, tools: [{ id: 'claude', displayName: 'Claude' }, { id: 'codex', displayName: 'Codex' }], connection: 'online', refresh: vi.fn() }) }));
vi.mock('./useConversationStream', () => ({ useConversationStream: () => ({ ...live, stream: 'live', answer: vi.fn(), answering: false, answered: null }) }));
beforeEach(() => {
  localStorage.clear(); vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('updates the actual header for both CLIs, keeps footer metadata compact, and launches in Desktop', async () => {
  const reducer = new CodexEventStream();
  const event = (sequence: number, method: string, params: Record<string, unknown>) => ({ sequence, message: { method, params: { threadId: 'root', ...params } } });
  const page = { epoch: 'e', cursor: 1, reset: true, online: true, complete: true, thread_id: 'root' };
  live.codex = reducer.apply({ ...page, events: [event(1, 'sinos/thread', { title: 'Codex project title', cwd: '/Desktop/codex-project', model: 'gpt-test' })] });
  const client = { chat: vi.fn().mockResolvedValue({ bound: false }) } as unknown as RemoteClient;
  const view = render(<PhoneWorkspace client={client} />);
  await act(async () => {});
  const header = () => view.container.querySelector('.phone-heading')!;
  expect(header().textContent).toContain('Claude project title');
  expect(header().textContent).toContain('/Desktop/claude-project');
  expect(screen.getByLabelText('会话状态').textContent).toContain('18%');
  expect(screen.getByLabelText('会话状态').textContent).not.toContain('claude-project');
  fireEvent.click(screen.getByLabelText('打开会话列表'));
  fireEvent.click(screen.getByRole('button', { name: /^Codex/ }));
  await act(async () => {});
  expect(header().textContent).toContain('Codex project title');
  expect(header().textContent).toContain('/Desktop/codex-project');
  expect(header().textContent).not.toContain('old-home');
  live.codex = reducer.apply({ ...page, reset: false, cursor: 3, events: [
    event(2, 'thread/name/updated', { threadName: 'Renamed Codex title' }),
    event(3, 'thread/settings/updated', { threadSettings: { cwd: '/Desktop/moved-project' } }),
  ] });
  view.rerender(<PhoneWorkspace client={client} />);
  expect(header().textContent).toContain('Renamed Codex title');
  expect(header().textContent).toContain('/Desktop/moved-project');
  fireEvent.click(screen.getByLabelText('新建会话'));
  expect((screen.getByPlaceholderText('留空使用电脑桌面') as HTMLInputElement).value).toBe('/Users/test/Desktop');
});
