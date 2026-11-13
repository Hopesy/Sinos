// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RelayDeviceList, type RelayDeviceInfo } from './RelayDeviceList';
afterEach(cleanup);
const device = (id: string, online: boolean, pairedAt: number): RelayDeviceInfo => ({ pairId: id, deviceName: 'Android 手机', relayUrl: 'https://relay.example', online, pairedAt, state: 'connected' });

it('distinguishes same-name devices and folds offline records without revoking or merging them', () => {
  const action = vi.fn();
  const devices = [device('device-111111', true, 1), device('device-222222', false, 3), device('device-333333', true, 2)];
  const view = render(<RelayDeviceList devices={devices} busy={false} action={action} />);
  const online = within(screen.getByRole('list', { name: '在线设备' })).getAllByRole('listitem');
  expect(online.map(row => row.getAttribute('aria-label'))).toEqual(['Android 手机 · 333333', 'Android 手机 · 111111']);
  expect(view.container.querySelector('details')?.open).toBe(false);
  expect(view.container.querySelectorAll('.relay-device')).toHaveLength(3);
  view.rerender(<RelayDeviceList devices={devices.map(d => ({ ...d, online: d.pairId.endsWith('222222') }))} busy={false} action={action} />);
  expect(within(screen.getByRole('list', { name: '在线设备' })).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('list', { name: '在线设备' }).textContent).toContain('222222');
  expect(action).not.toHaveBeenCalled();
});

it('renames only the selected pairing and retains the edit if saving fails', async () => {
  const action = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<RelayDeviceList devices={[device('device-111111', true, 1), device('device-222222', true, 2)]} busy={false} action={action} />);
  fireEvent.click(screen.getByRole('button', { name: '修改备注 Android 手机 · 111111' }));
  fireEvent.change(screen.getByRole('textbox', { name: '设备备注 111111' }), { target: { value: ' 我的 Pixel ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(action).toHaveBeenCalledWith('relay_rename_device', { pairId: 'device-111111', deviceName: '我的 Pixel' }));
  expect(screen.getByRole('textbox').getAttribute('value')).toBe(' 我的 Pixel ');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
});

it('keeps a replaced connection offline and requires an explicit takeover', async () => {
  const action = vi.fn().mockResolvedValue(true);
  const replaced = { ...device('device-111111', true, 1), state: 'replaced' };
  const view = render(<RelayDeviceList devices={[replaced]} busy={false} action={action} />);
  expect(screen.queryByRole('list', { name: '在线设备' })).toBeNull();
  expect(screen.getByText('已被接管')).toBeTruthy();
  expect(screen.getByText('其他 Sinos CLI 实例已接管，当前实例已暂停自动重连。')).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
  const takeover = screen.getByRole('button', { name: '在此接管 Android 手机 · 111111' });
  fireEvent.click(takeover);
  await waitFor(() => expect(action).toHaveBeenCalledWith('relay_resume_device', { pairId: replaced.pairId }));
  expect(action).toHaveBeenCalledTimes(1);
  view.rerender(<RelayDeviceList devices={[{ ...replaced, online: false, state: 'connecting' }]} busy={false} action={action} />);
  expect(screen.queryByRole('button', { name: /在此接管/ })).toBeNull();
});

it('never offers takeover for revoked records and prevents takeover while busy', () => {
  const action = vi.fn().mockResolvedValue(true);
  const replaced = { ...device('device-111111', false, 1), state: 'replaced' };
  const revoked = { ...device('device-222222', false, 2), state: 'revoked' };
  render(<RelayDeviceList devices={[replaced, revoked]} busy action={action} />);
  const buttons = screen.getAllByRole('button', { name: /在此接管/ });
  expect(buttons).toHaveLength(1);
  expect(buttons[0].hasAttribute('disabled')).toBe(true);
  fireEvent.click(buttons[0]);
  expect(action).not.toHaveBeenCalled();
});

it('revokes only the selected pairing directly and disables actions while busy', async () => {
  const action = vi.fn().mockResolvedValue(true);
  const devices = [device('device-111111', true, 1), device('device-222222', true, 2)];
  const view = render(<RelayDeviceList devices={devices} busy={false} action={action} />);
  const revoke = screen.getByRole('button', { name: '撤销 Android 手机 · 111111' });
  expect(revoke.textContent).toBe('');
  expect(revoke.getAttribute('title')).toBe('撤销配对');
  fireEvent.click(revoke);
  await waitFor(() => expect(action).toHaveBeenCalledWith('relay_revoke_device', { pairId: 'device-111111' }));
  expect(action).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('确认撤销')).toBeNull();
  expect(screen.queryByRole('button', { name: '取消撤销' })).toBeNull();
  view.rerender(<RelayDeviceList devices={devices} busy action={action} />);
  fireEvent.click(revoke);
  fireEvent.click(screen.getByRole('button', { name: '撤销 Android 手机 · 222222' }));
  expect(action).toHaveBeenCalledTimes(1);
});
