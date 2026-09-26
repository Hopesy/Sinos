// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RelaySettings } from './RelaySettings';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const relayUrl = 'https://relay.example';
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async command => {
    if (command === 'relay_status') return { relayUrl, inviteUrl: null, expiresAt: null, error: null, devices: [] };
    if (command === 'relay_test_connection') return { latencyMs: 125 };
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

it('tests the entered relay without creating an invitation, and clears stale results after editing', async () => {
  render(<RelaySettings />);
  const input = screen.getByLabelText('Cloudflare 中继地址');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(relayUrl));
  expect(input.getAttribute('type')).toBe('password');
  fireEvent.click(screen.getByRole('button', { name: '显示中继地址' }));
  expect(input.getAttribute('type')).toBe('url');
  fireEvent.click(screen.getByRole('button', { name: '隐藏中继地址' }));
  expect(input.getAttribute('type')).toBe('password');
  expect(screen.getByRole('button', { name: '测试连接' }).textContent).toBe('');
  fireEvent.change(input, { target: { value: 'https://custom.example' } });
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  await screen.findByText('中继服务可达 · 125 ms');
  expect(invoke).toHaveBeenCalledWith('relay_test_connection', { relayUrl: 'https://custom.example' });
  expect(invoke.mock.calls.some(([command]) => command === 'relay_create_pairing')).toBe(false);
  fireEvent.change(input, { target: { value: relayUrl } });
  expect(screen.queryByText('中继服务可达 · 125 ms')).toBeNull();
});

it('shows connection errors and allows another test', async () => {
  render(<RelaySettings />);
  await waitFor(() => expect((screen.getByLabelText('Cloudflare 中继地址') as HTMLInputElement).value).toBe(relayUrl));
  invoke.mockRejectedValueOnce('无法连接中继，请检查地址、网络或证书后重试');
  fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
  expect((await screen.findByRole('alert')).textContent).toContain('无法连接中继');
  expect((screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled).toBe(false);
});
