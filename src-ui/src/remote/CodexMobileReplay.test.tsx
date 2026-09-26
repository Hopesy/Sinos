// @vitest-environment jsdom
// Only the network boundary is faked. Exercise the production socket hook,
// VT decoder, event reducer and chat components together with real CLI bytes.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';
import type { RemoteClient, RemoteSocket } from './client';
import { codexRealTui as fixture } from './fixtures/codexRealTui';
import { TerminalConversation } from './TerminalConversation';

afterEach(cleanup);

class Socket implements RemoteSocket {
  readyState = 0;
  onopen: RemoteSocket['onopen'] = null;
  onmessage: RemoteSocket['onmessage'] = null;
  onclose: RemoteSocket['onclose'] = null;
  onerror: RemoteSocket['onerror'] = null;
  send = vi.fn();
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  receive(data: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }
}

it('decodes the real startup without a fake user prompt or empty text code card', async () => {
  const decoder = new TerminalConversation(fixture.cols, fixture.rows, 'codex');
  try {
    const result = await decoder.write(fixture.startupFrames.join(''));
    expect(result.question).toBeNull();
    expect(result.events.some(event => event.kind === 'user')).toBe(false);
    expect(result.events.some(event => /Ask Codex to do anything|```text\s*```/.test(event.text))).toBe(false);
  } finally { decoder.dispose(); }
});

it('renders real approvals, live reasoning, tools and Markdown through the full mobile pipeline', async () => {
  localStorage.clear();
  const ws = new Socket();
  const client = {
    socket: vi.fn(() => ws), answer: vi.fn().mockResolvedValue(undefined), prompt: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn().mockResolvedValue({ bound: false, data: '', cursor: 0, revision: '0', sourceId: null }),
  } as unknown as RemoteClient;
  const session = { id: 'fixture', tool: 'codex', cwd: 'C:/Projects/fixture', running: true, paused: false, cols: fixture.cols, rows: fixture.rows, output_chunks: 0 };
  const view = render(<ChatView client={client} session={session} online toolName="Codex" onTitle={vi.fn()} insert="" onInserted={vi.fn()} />);
  await waitFor(() => expect(client.socket).toHaveBeenCalledOnce());
  act(() => ws.open());
  let cursor = 0;
  function through(method: string) {
    const end = fixture.page.events.findIndex((event, i) => i >= cursor && event.message.method === method) + 1;
    expect(end).toBeGreaterThan(cursor);
    act(() => ws.receive({ type: 'codex', page: { ...fixture.page, reset: cursor === 0, cursor: end, events: fixture.page.events.slice(cursor, end) } }));
    cursor = end;
  }
  through('item/commandExecution/requestApproval');
  act(() => ws.receive({ type: 'output', data: fixture.approvalFrames.join(''), sequence: 42 }));
  const decline = await screen.findByRole('button', { name: /No, and tell Codex/ });
  await waitFor(() => expect((decline as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText(/Would you like to run the following command/)).toBeTruthy();
  expect(screen.getByText(/May I run the isolated mobile fixture command/)).toBeTruthy();
  expect(view.container.querySelector('[data-tool-kind="shell"]')).toBeTruthy();
  expect(client.answer).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(decline));
  expect(client.answer).toHaveBeenCalledExactlyOnceWith('fixture', '\x1b[B\x1b[B\r', 42);
  act(() => ws.receive({ type: 'reset' }));
  through('item/reasoning/summaryTextDelta');
  expect(screen.getByText('Checking the mobile fixture.')).toBeTruthy();
  expect(view.container.querySelector('details.tool-reasoning[open] .spin')).toBeTruthy();
  expect(screen.getByLabelText('生成状态').textContent).toContain('思考');
  const footer = screen.getByLabelText('会话状态');
  expect(footer.textContent).toContain('sinos-test');
  expect(footer.closest('.chat-scroll')).toBeNull();
  through('item/agentMessage/delta');
  const article = view.container.querySelector('article.assistant');
  expect(article?.querySelector('li strong')?.textContent).toBe('First');
  through('item/agentMessage/delta');
  expect(view.container.querySelector('article.assistant')).toBe(article);
  expect(article?.querySelectorAll('ol li')).toHaveLength(2);
  expect(article?.querySelector('pre')?.textContent).toContain('const x = 1;');
  expect(screen.getByLabelText('生成状态')).toBeTruthy();
  through('turn/completed');
  expect(screen.queryByLabelText('生成状态')).toBeNull();
  expect(screen.getByLabelText('会话状态')).toBe(footer);
  expect(view.container.querySelector('details.tool-reasoning .spin')).toBeNull();
  expect(screen.queryByText('Ask Codex to do anything')).toBeNull();
  expect(view.container.querySelector('.xterm, canvas')).toBeNull();
  expect(ws.send).not.toHaveBeenCalled();
});
