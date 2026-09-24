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
