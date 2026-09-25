// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ enabled: false, readPairing: vi.fn(), writePairing: vi.fn(), clearPairing: vi.fn(), checkStorage: vi.fn() }));
vi.mock('../native/bridge', () => ({ get isAndroidApp() { return native.enabled; }, SinosMobile: native }));
import { checkDeviceStorage, forgetDevice, savedDevice, saveDevice, validateInvite, validateRelay } from './deviceStorage';
const pk = 'A'.repeat(43);
const device = { pairId: 'a'.repeat(22), relay: 'https://relay.example', token: 'device-token', contentKey: pk, name: 'Android' };
beforeEach(() => { native.enabled = false; vi.clearAllMocks(); localStorage.clear(); });

it('keeps browser pairing scoped to the current origin', () => {
  expect(validateRelay(location.origin)).toBe(location.origin);
  expect(() => validateRelay(device.relay)).toThrow();
});
it('permits HTTPS native pairing but rejects cleartext and credential-bearing origins', () => {
  native.enabled = true;
  expect(validateInvite(`https://relay.example/#pk=${pk}`).relay).toBe(device.relay);
  for (const relay of ['http://relay.example', 'https://user:password@relay.example', 'https://relay.example/path', 'https://relay.example/?token=x']) expect(() => validateRelay(relay)).toThrow();
});
it('rejects a QR that redirects its embedded key to a different relay', () => {
  native.enabled = true;
  expect(() => validateInvite(`https://expected.example/#relay=https://other.example&pk=${pk}`)).toThrow();
  expect(() => validateInvite('https://relay.example/#pk=AAAA')).toThrow();
});
it('restores native pairing from the vault, never from web localStorage', async () => {
  native.enabled = true; native.readPairing.mockResolvedValue({ value: JSON.stringify(device) });
  expect(await savedDevice()).toEqual(device);
  await checkDeviceStorage(); await saveDevice(device); await forgetDevice();
  expect(native.checkStorage).toHaveBeenCalledOnce();
  expect(native.writePairing).toHaveBeenCalledWith({ value: JSON.stringify(device) });
  expect(native.clearPairing).toHaveBeenCalledOnce();
  expect(localStorage.length).toBe(0);
});
it('does not silently turn a vault failure into an unpaired device', async () => {
  native.enabled = true; native.readPairing.mockRejectedValue(new Error('locked'));
  await expect(savedDevice()).rejects.toThrow('locked');
});
it('rejects corrupted records and preserves browser persistence', async () => {
  native.enabled = true; native.readPairing.mockResolvedValue({ value: JSON.stringify({ ...device, contentKey: 'bad' }) });
  expect(await savedDevice()).toBeNull();
  native.enabled = false; const local = { ...device, relay: location.origin };
  await saveDevice(local); expect(await savedDevice()).toEqual(local);
  await forgetDevice(); expect(await savedDevice()).toBeNull();
});
