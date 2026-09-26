// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShareSheet } from './ShareSheet';
import type { RelayClient } from '../pair/RelayClient';

// Use the actual shared clipboard helper: this reproduces a phone browser with
// no async clipboard while the share sheet is a modal dialog.
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('navigator', {});
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (document as unknown as Record<string, unknown>).execCommand; });

it.each([true, false])('reports the real result of copying from the share modal (%s)', async accepted => {
  const url = 'https://relay.test/#share=fixture';
  const rpc = vi.fn().mockImplementation(async (action: string) => action === 'session.share_list' ? { shares: [] } : { id: 'fixture', mode: 'view', state: 'pending', expiresAt: Date.now() + 3600000, url });
  const exec = vi.fn(() => {
    const selected = document.activeElement as HTMLTextAreaElement;
    expect(selected.closest('dialog[open]')).not.toBeNull();
    expect(selected.value).toBe(url);
    return accepted;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
  render(<ShareSheet client={{ rpc } as unknown as RelayClient} sessionId="shared" onClose={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成一次性链接' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制链接' })); });
  expect(exec).toHaveBeenCalledExactlyOnceWith('copy');
  if (accepted) {
    const copied = screen.getByRole('button', { name: '已复制' });
    exec.mockReturnValueOnce(false);
    await act(async () => { fireEvent.click(copied); });
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('复制失败');
  }
  else {
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('复制失败');
  }
});
