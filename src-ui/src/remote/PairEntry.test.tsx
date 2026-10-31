// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PairEntry } from './PairEntry';

const mocks = vi.hoisted(() => ({ savedDevice: vi.fn(), connect: vi.fn(), dispose: vi.fn() }));
vi.mock('./pair/RelayClient', () => ({
  savedDevice: mocks.savedDevice,
  claimDevice: vi.fn(),
  RelayClient: class {
    constructor(device: unknown) { mocks.connect(device); }
    dispose() { mocks.dispose(); }
  },
}));
vi.mock('./RemoteApp', () => ({ RemoteApp: () => <div>Paired workspace</div> }));
vi.mock('./useMobileViewport', () => ({ useMobileViewport: () => {} }));
vi.mock('./usePhoneAppearance', () => ({ usePhoneAppearance: () => ({ theme: 'dark', style: {} }) }));

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  window.history.replaceState(null, '', '/remote/#pair=legacy-token');
});
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

it('opens pairing at a legacy direct URL when no relay device is saved', async () => {
  mocks.savedDevice.mockResolvedValue(null);
  render(<PairEntry />);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(screen.getByRole('heading', { name: '连接到 Sinos' })).toBeTruthy();
  expect(screen.queryByText('Paired workspace')).toBeNull();
  expect(mocks.savedDevice).toHaveBeenCalledOnce();
  expect(mocks.connect).not.toHaveBeenCalled();
});

it('restores a saved relay device even at a legacy direct URL', async () => {
  const device = { pairId: 'paired-device', relay: 'https://relay.example' };
  mocks.savedDevice.mockResolvedValue(device);
  const view = render(<PairEntry />);
  expect(await screen.findByText('Paired workspace')).toBeTruthy();
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(device);
  view.unmount();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});
