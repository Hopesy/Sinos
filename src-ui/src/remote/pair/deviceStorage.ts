import { fromBase64Url, parsePairUri } from './encoding';
import { isAndroidApp, SinosMobile } from '../native/bridge';

export interface PairedDevice { pairId: string; relay: string; token: string; contentKey: string; name: string }
const STORAGE = 'coffee-paired-computer';

export function validateRelay(relay: string): string {
  const url = new URL(relay);
  if (url.username || url.password || url.search || url.hash || !/^\/?$/.test(url.pathname)) throw new Error('中继地址无效。');
  if (isAndroidApp) {
    if (url.protocol !== 'https:') throw new Error('App 配对需要 HTTPS 中继地址。');
  } else if (url.origin !== location.origin) throw new Error('请在配对链接对应的中继网站打开链接。');
  return url.origin;
}
export function validateInvite(link: string) {
  const invite = parsePairUri(link);
  invite.relay = validateRelay(invite.relay);
  if (invite.publicKey.length !== 32) throw new Error('配对链接不完整，请重新复制链接或扫码。');
  // A QR URL cannot silently redirect pairing credentials to another relay.
  if (/^https?:/i.test(link.trim()) && new URL(link.trim()).origin !== invite.relay) throw new Error('配对链接与中继地址不一致。');
  return invite;
}
export async function savedDevice(): Promise<PairedDevice | null> {
  const raw = isAndroidApp ? (await SinosMobile.readPairing()).value : localStorage.getItem(STORAGE);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PairedDevice;
    if (!/^[\w-]{22}$/.test(value.pairId) || fromBase64Url(value.contentKey).length !== 32 || typeof value.token !== 'string' || !value.token) return null;
    validateRelay(value.relay);
    return value;
  } catch { return null; }
}
export async function checkDeviceStorage() {
  if (isAndroidApp) await SinosMobile.checkStorage();
  else { localStorage.setItem(`${STORAGE}-check`, '1'); localStorage.removeItem(`${STORAGE}-check`); }
}
export async function saveDevice(device: PairedDevice) {
  const value = JSON.stringify(device);
  if (isAndroidApp) await SinosMobile.writePairing({ value });
  else localStorage.setItem(STORAGE, value);
}
export async function forgetDevice() {
  if (isAndroidApp) await SinosMobile.clearPairing();
  else localStorage.removeItem(STORAGE);
}
