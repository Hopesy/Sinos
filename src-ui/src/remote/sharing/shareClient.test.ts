// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claimShare, forgetShare, savedShare } from './shareClient';
import { generatePairKeypair, openBoxedContentKey } from '../pair/crypto';
import { fromBase64Url, toBase64Url } from '../pair/encoding';
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => vi.unstubAllGlobals());

it('keeps temporary credentials separate, supports reload, and wraps only the new content key', async () => {
  localStorage.setItem('coffee-paired-computer', 'owner-pairing');
  const pair = generatePairKeypair(), id = toBase64Url(pair.publicKey);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pairId: 'p'.repeat(22), deviceToken: 't'.repeat(32) })));
  vi.stubGlobal('fetch', fetch);
  expect(savedShare(id)).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  const device = await claimShare(id);
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(request.temporaryOnly).toBe(true);
  const [ephPublicKey, nonce, boxed] = request.boxedKey.split('.').map(fromBase64Url);
  expect(openBoxedContentKey({ ephPublicKey, nonce, boxed }, pair.secretKey)).toEqual(fromBase64Url(device.contentKey));
  expect(savedShare(id)).toEqual(device);
  expect(location.hash).toBe(`#guest=${id}`);
  expect(localStorage.getItem('coffee-paired-computer')).toBe('owner-pairing');
  forgetShare(id); expect(savedShare(id)).toBeNull();
  expect(localStorage.getItem('coffee-paired-computer')).toBe('owner-pairing');
});

it('does not save rejected or malformed invitations', async () => {
  const id = toBase64Url(generatePairKeypair().publicKey);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('already claimed', { status: 409 })));
  await expect(claimShare(id)).rejects.toThrow('already claimed');
  expect(savedShare(id)).toBeNull();
  await expect(claimShare('invalid')).rejects.toThrow('invalid share');
});
