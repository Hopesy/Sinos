// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShareSheet } from './ShareSheet';
import type { RelayClient } from '../pair/RelayClient';
import { clipboardWrite } from '../../lib/clipboard';
vi.mock('../../lib/clipboard', () => ({ clipboardWrite: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it('creates a scoped one-time grant with explicit control, copies it and revokes directly', async () => {
  const grant = { id: 'grant', mode: 'control', state: 'pending', expiresAt: Date.now() + 900000, url: 'https://relay.test/#share=grant' };
  const rpc = vi.fn().mockImplementation(async (action: string) => action === 'session.share_list' ? { shares: [] } : action === 'session.share_create' ? grant : { ...grant, state: 'ended', url: null });
  render(<ShareSheet client={{ rpc } as unknown as RelayClient} sessionId="shared" onClose={vi.fn()} />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: /只读查看/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /允许控制/ }));
  expect(screen.getByText(/可能修改项目文件/)).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: '15 分钟' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成一次性链接' })); });
  expect(rpc).toHaveBeenCalledWith('session.share_create', 'shared', { mode: 'control', minutes: 15 });
  expect((screen.getByLabelText('分享链接') as HTMLInputElement).value).toBe(grant.url);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制链接' })); });
  expect(clipboardWrite).toHaveBeenCalledWith(grant.url, { throwOnError: true });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销分享' })); });
  expect(rpc).toHaveBeenLastCalledWith('session.share_revoke', 'shared', { id: 'grant' });
  expect(screen.queryByLabelText('分享链接')).toBeNull();
  expect(screen.getByText('已结束')).toBeTruthy();
});

it('does not let a stale poll remove a newly generated invitation', async () => {
  let finish!: (result: unknown) => void;
  const rpc = vi.fn().mockImplementation((action: string) => action === 'session.share_list' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ id: 'new', mode: 'view', state: 'pending', expiresAt: Date.now() + 3600000, url: 'https://relay.test/#share=new' }));
  render(<ShareSheet client={{ rpc } as unknown as RelayClient} sessionId="shared" onClose={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成一次性链接' })); });
  expect(rpc).toHaveBeenCalledWith('session.share_create', 'shared', { mode: 'view', minutes: 60 });
  await act(async () => { finish({ shares: [] }); });
  expect(screen.getByLabelText('分享链接')).toBeTruthy();
});

it('acknowledges a slow tap immediately, blocks duplicates, then reveals the generated link', async () => {
  let complete!: (value: unknown) => void;
  const rpc = vi.fn().mockImplementation((action: string) => action === 'session.share_list' ? Promise.resolve({ shares: [] }) : new Promise(resolve => { complete = resolve; }));
  render(<ShareSheet client={{ rpc } as unknown as RelayClient} sessionId="shared" onClose={vi.fn()} />);
  await act(async () => {});
  expect((screen.getByRole('radio', { name: '1 小时' }) as HTMLInputElement).checked).toBe(true);
  const create = screen.getByRole('button', { name: '生成一次性链接' });
  fireEvent.click(create); fireEvent.click(create);
  expect(create.getAttribute('aria-busy')).toBe('true');
  expect(create.querySelector('.share-spinner')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('正在与电脑');
  expect(rpc.mock.calls.filter(([action]) => action === 'session.share_create')).toHaveLength(1);
  await act(async () => { complete({ id: 'created', mode: 'view', state: 'pending', expiresAt: Date.now() + 3600000, url: 'https://relay.test/#share=created' }); });
  expect(screen.getByRole('status').textContent).toContain('链接已生成');
  expect(screen.getByRole('button', { name: '再生成一个链接' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '复制链接' })).toBeTruthy();
});

it('shows a failed generation next to the button and permits an explicit retry', async () => {
  const rpc = vi.fn().mockImplementation(async (action: string) => { if (action === 'session.share_list') return { shares: [] }; throw new Error('offline'); });
  render(<ShareSheet client={{ rpc } as unknown as RelayClient} sessionId="shared" onClose={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成一次性链接' })); });
  expect(screen.getByRole('alert').textContent).toContain('电脑是否在线');
  expect((screen.getByRole('button', { name: '重新生成链接' }) as HTMLButtonElement).disabled).toBe(false);
});
