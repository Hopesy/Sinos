import { RemoteError } from '../client';
import type { PairedDevice } from '../pair/deviceStorage';
import { generateContentKey, boxContentKey } from '../pair/crypto';
import { fromBase64Url, toBase64Url } from '../pair/encoding';

const storageKey = (id: string) => `sinos-temporary-share:${id}`;
export function shareError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/SHARE_(EXPIRED|ENDED)|already claimed|expired|no pending/.test(message) || error instanceof RemoteError && [401, 403, 410].includes(error.status)) return '分享已被领取、到期或撤销，请联系分享者重新生成链接。';
  if (message === 'SHARE_LIMIT') return '临时分享数量已达上限，请先撤销不再使用的链接。';
  if (message === 'UNKNOWN_ACTION') return '请更新电脑端后使用临时分享。';
  return '暂时无法连接分享，请检查网络及电脑是否在线。';
}
export function savedShare(id: string): PairedDevice | null {
  try {
    const device = JSON.parse(sessionStorage.getItem(storageKey(id)) || 'null') as PairedDevice | null;
    return device && device.relay === location.origin && /^[\w-]{22}$/.test(device.pairId) && fromBase64Url(device.contentKey).length === 32 && typeof device.token === 'string' && /^[\w-]{32}$/.test(device.token) ? device : null;
  } catch { return null; }
}
export function forgetShare(id: string) { try { sessionStorage.removeItem(storageKey(id)); } catch { /* memory access still ends */ } }
export async function claimShare(id: string): Promise<PairedDevice> {
  if (!/^[\w-]{43}$/.test(id)) throw new Error('invalid share');
  // Explicit user action consumes the invitation; link previews and page
  // reloads never claim it. Keep guest keys separate from permanent pairing.
  const key = generateContentKey(), boxed = boxContentKey(key, fromBase64Url(id));
  const response = await fetch('/v1/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ publicKey: id, boxedKey: [boxed.ephPublicKey, boxed.nonce, boxed.boxed].map(toBase64Url).join('.'), deviceName: '临时访客', temporaryOnly: true }) });
  if (!response.ok) throw new RemoteError(response.status, (await response.text()).slice(0, 300));
  const result = await response.json() as { pairId: string; deviceToken: string };
  if (!/^[\w-]{22}$/.test(result.pairId) || !/^[\w-]{32}$/.test(result.deviceToken)) throw new Error('invalid share response');
  const device = { pairId: result.pairId, token: result.deviceToken, relay: location.origin, contentKey: toBase64Url(key), name: '临时访客' };
  try { sessionStorage.setItem(storageKey(id), JSON.stringify(device)); } catch { /* the current tab can still connect */ }
  history.replaceState(null, '', `${location.pathname}#guest=${id}`);
  return device;
}
