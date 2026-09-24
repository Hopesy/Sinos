// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FilesView } from './FilesView';
import { RemoteClient, RemoteError } from './client';

const file = { content: 'original\n', revision: 'v1', line_ending: 'lf', has_utf8_bom: false, size: 9 };
const client = new RemoteClient('http://localhost', 'test');
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(client, 'directory').mockResolvedValue({ entries: [{ name: 'App.tsx', path: 'App.tsx', is_dir: false, size: 9 }], truncated: false });
  vi.spyOn(client, 'file').mockResolvedValue(file);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function openEditor() {
  await act(async () => { screen.getByRole('button', { name: /App\.tsx\s*9 B/ }).click(); });
  fireEvent.click(screen.getByRole('button', { name: '编辑文件' }));
}

it('keeps the editor and the local draft when the desktop rejects a stale save', async () => {
  const save = vi.spyOn(client, 'save').mockRejectedValue(new RemoteError(409, 'conflict'));
  render(<FilesView client={client} sessionId="one" online onAttach={vi.fn()} />);
  await act(async () => {});
  await openEditor();
  fireEvent.change(screen.getByRole('textbox', { name: '文件内容' }), { target: { value: 'my changes' } });
  await act(async () => { screen.getByRole('button', { name: '保存' }).click(); });
  expect(save).toHaveBeenCalledWith('one', 'App.tsx', 'my changes', file);
  expect(screen.getByRole('textbox', { name: '文件内容' }).getAttribute('disabled')).toBeNull();
  expect((screen.getByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement).value).toBe('my changes');
  expect(screen.getByText(/文件已在电脑端发生变化/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);
  expect(localStorage.getItem('sinos-mobile-file-draft-one-App.tsx')).toContain('my changes');
});

it('restores an unsaved edit after remounting and does not silently rebase its revision', async () => {
  localStorage.setItem('sinos-mobile-file-draft-one-App.tsx', JSON.stringify({ content: 'unsaved', file }));
  vi.mocked(client.file).mockResolvedValue({ ...file, content: 'AI changed this', revision: 'v2' });
  render(<FilesView client={client} sessionId="one" online onAttach={vi.fn()} />);
  await act(async () => {});
  await act(async () => { screen.getByRole('button', { name: /App\.tsx\s*9 B/ }).click(); });
  expect((screen.getByRole('textbox', { name: '文件内容' }) as HTMLTextAreaElement).value).toBe('unsaved');
  expect(screen.getByText('电脑端有新的版本，草稿已保留。')).toBeTruthy();
});

it('does not show files returned late for a previous directory', async () => {
  let finish!: (value: { entries: never[]; truncated: boolean }) => void;
  vi.mocked(client.directory).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<FilesView client={client} sessionId="old" online onAttach={vi.fn()} />);
  view.unmount();
  render(<FilesView client={client} sessionId="new" online onAttach={vi.fn()} />);
  await act(async () => {});
  await act(async () => { finish({ entries: [], truncated: false }); });
  expect(screen.getByRole('button', { name: /App\.tsx\s*9 B/ })).toBeTruthy();
});
