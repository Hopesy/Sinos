import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, claim, tokenValid, canFetchCredentials, PAIR_TTL_MS, pairIdFromPublicKey } from '../src/pairing.ts';

test('invites expire and cannot be claimed twice', () => {
  const invite = request(undefined, 0, 'public', 'owner-secret');
  assert.equal(claim(invite, PAIR_TTL_MS + 1, 'box', 'phone').ok, false);
  const paired = claim(invite, 1, 'box', 'phone');
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  assert.equal(claim(paired.next, 2, 'box', 'another phone').ok, false);
  assert.equal(tokenValid(paired.next, 'host', paired.next.hostToken!), true);
  assert.equal(tokenValid(paired.next, 'guest', paired.next.hostToken!), false);
  assert.equal(tokenValid(paired.next, 'guest', ''), false);
  assert.equal(canFetchCredentials(paired.next, 120_002), false);
  assert.equal(paired.next.requestToken, 'owner-secret');
  const lastSecond = claim(invite, PAIR_TTL_MS - 1, 'box', 'phone');
  assert.equal(lastSecond.ok, true);
  if (lastSecond.ok) assert.equal(canFetchCredentials(lastSecond.next, PAIR_TTL_MS + 15_000), true);
});

test('room IDs are stable and bound to the public key', async () => {
  const a = await pairIdFromPublicKey('a');
  assert.equal(a.length, 22);
  assert.equal(a, await pairIdFromPublicKey('a'));
  assert.notEqual(a, await pairIdFromPublicKey('b'));
});

test('temporary shares allow one claim, keep the original deadline and expire reconnect tokens', () => {
  const now = 1_000_000;
  const invite = request(undefined, now, 'share-public', 'owner-secret', 3_600_000);
  assert.equal(invite.inviteExpiresAt, now + 600_000);
  assert.equal(invite.expiresAt, now + 3_600_000);
  assert.equal(claim(invite, now + 600_001, 'box', 'guest').ok, false);
  const paired = claim(invite, now + 10, 'box', 'guest');
  assert(paired.ok);
  assert.equal(claim(paired.next, now + 11, 'another-box', 'other').ok, false);
  assert.equal(request(paired.next, now + 12, 'share-public', 'owner-secret', 14_400_000).expiresAt, invite.expiresAt);
  assert.equal(tokenValid(paired.next, 'guest', paired.next.deviceToken!, now + 3_599_999), true);
  assert.equal(tokenValid(paired.next, 'guest', paired.next.deviceToken!, now + 3_600_000), false);
  assert.equal(tokenValid(paired.next, 'host', paired.next.hostToken!, now + 3_600_000), false);
});
