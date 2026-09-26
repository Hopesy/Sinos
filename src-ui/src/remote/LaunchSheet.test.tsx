// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchSheet } from './LaunchSheet';
import { RemoteClient, RemoteError, storageWrite } from './client';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); localStorage.clear(); });
const client = { launch: vi.fn() } as unknown as RemoteClient;
function mount(cwd = 'C:\\Users\\tester\\Desktop') {
  return render(<LaunchSheet client={client} tools={[{ id: 'claude', displayName: 'Claude' }]} sessions={[]} cwd={cwd} onClose={vi.fn()} onLaunched={vi.fn()} />);
}
it('defaults to the desktop reported by the PC, ignoring a previously remembered project', async () => {
  storageWrite('last-project', 'C:\\old-project');
  vi.mocked(client.launch).mockResolvedValue({ session_id: 'new' });
  mount();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('C:\\Users\\tester\\Desktop');
  await act(async () => { fireEvent.click(screen.getByText('启动会话')); });
  expect(client.launch).toHaveBeenLastCalledWith('claude', 'C:\\Users\\tester\\Desktop');
});
it('allows a new nested directory and reports creation errors without closing the form', async () => {
  vi.mocked(client.launch).mockRejectedValue(new RemoteError(400, 'CWD_CREATE_FAILED: denied'));
  mount();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new project/child' } });
  await act(async () => { fireEvent.click(screen.getByText('启动会话')); });
  expect(client.launch).toHaveBeenLastCalledWith('claude', 'new project/child');
  expect(screen.getByRole('alert').textContent).toContain('无法创建文件夹');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('new project/child');
});
