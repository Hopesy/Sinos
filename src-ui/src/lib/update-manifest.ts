// Desktop versions, notes and installers come from Sinos GitHub Releases.
// Model-price catalogues are independent of the product update channel.
const RELEASES_API = 'https://api.github.com/repos/Hopesy/Sinos/releases';
export const MANIFEST_SOURCES = [`${RELEASES_API}/latest`] as const;

export interface UpdateManifest {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

export function isNewerVersion(remote: string, local: string): boolean {
  if (!SEMVER.test(remote) || !SEMVER.test(local)) return false;
  const r = remote.split('.').map(Number), l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (r[i] !== l[i]) return r[i] > l[i];
  }
  return false;
}

function asManifest(body: unknown): UpdateManifest | null {
  if (!body || typeof body !== 'object') return null;
  const release = body as Record<string, unknown>;
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string') return null;
  const version = release.tag_name.replace(/^v/, '');
  if (!SEMVER.test(version)) return null;
  return {
    version,
    releaseDate: typeof release.published_at === 'string' ? release.published_at : undefined,
    releaseNotes: typeof release.body === 'string' ? release.body : undefined,
  };
}

// Each request is bounded by its own timeout and by the caller's lifetime.
async function fetchOne(url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<UpdateManifest | null> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let manifest: UpdateManifest | null = null;
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (response.ok) manifest = asManifest(await response.json());
  } catch { /* Offline, rate-limited or timed out: retain the installed version. */ }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return manifest;
}

export async function fetchLatestManifest(signal?: AbortSignal, timeoutMs = 8000): Promise<UpdateManifest | null> {
  return fetchOne(MANIFEST_SOURCES[0], signal, timeoutMs);
}

// A newer published release must not supply notes for an older installed app.
export async function fetchNotesForVersion(version: string, signal: AbortSignal, timeoutMs = 8000): Promise<string> {
  if (!SEMVER.test(version)) return '';
  const latest = await fetchLatestManifest(signal, timeoutMs);
  if (latest?.version === version && latest.releaseNotes?.trim()) return latest.releaseNotes;
  const exact = await fetchOne(`${RELEASES_API}/tags/v${encodeURIComponent(version)}`, signal, timeoutMs);
  return exact?.version === version && exact.releaseNotes?.trim() ? exact.releaseNotes : '';
}
