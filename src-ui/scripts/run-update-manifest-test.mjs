import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Product updates stay on Sinos GitHub Releases; model-price catalogues are separate.
const source = readFileSync(new URL('../src/lib/update-manifest.ts', import.meta.url), 'utf8');
let respond;
const calls = [], timers = new Map();
let timerId = 0;
const context = {
  exports: {}, AbortController, DOMException,
  setTimeout: (run, delay) => { const id = ++timerId; timers.set(id, { run, delay }); return id; },
  clearTimeout: id => timers.delete(id),
  fetch: (url, options) => { calls.push({ url, options }); return respond(url, options); },
};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const { MANIFEST_SOURCES, isNewerVersion, fetchLatestManifest, fetchNotesForVersion } = context.exports;
const api = 'https://api.github.com/repos/Hopesy/Sinos/releases';
assert.deepEqual(Array.from(MANIFEST_SOURCES), [`${api}/latest`]);
for (const [remote, local, expected] of [
  ['4.0.6', '4.0.5', true], ['4.1.0', '4.0.9', true], ['4.0.5', '4.0.5', false],
  ['4.0.4', '4.0.5', false], ['5.0.0', '4.9.9', true], ['latest', '4.0.5', false],
  ['4.0.6', 'bad', false], ['4.0.6-beta', '4.0.5', false],
]) assert.equal(isNewerVersion(remote, local), expected, `${remote} vs ${local}`);
const ok = body => Promise.resolve({ ok: true, json: async () => body });
const release = (version, body = '') => ({ tag_name: `v${version}`, body, published_at: '2026-11-01T00:00:00Z', draft: false, prerelease: false });
respond = () => ok(release('4.0.5', 'installed notes'));
let manifest = await fetchLatestManifest();
assert.equal(manifest.version, '4.0.5');
assert.equal(manifest.releaseDate, '2026-11-01T00:00:00Z');
assert.equal(manifest.releaseNotes, 'installed notes');
assert.equal(calls.length, 1);
assert.equal(calls[0].options.cache, 'no-store');
assert.equal(timers.size, 0, 'successful requests clear their timeout');
for (const bad of [null, {}, { version: '99.0.0' }, { tag_name: 4 }, { tag_name: 'latest' },
  { ...release('4.0.6'), draft: true }, { ...release('4.0.6'), prerelease: true }, release('4.0.6-beta')]) {
  respond = () => ok(bad);
  assert.equal(await fetchLatestManifest(), null, 'ignore malformed, draft and prerelease responses');
}
respond = () => Promise.resolve({ ok: false, json: async () => release('99.0.0') });
assert.equal(await fetchLatestManifest(), null);
respond = () => Promise.resolve({ ok: true, json: async () => { throw new Error('bad json'); } });
assert.equal(await fetchLatestManifest(), null);
respond = () => Promise.reject(new Error('offline'));
assert.equal(await fetchLatestManifest(), null);

// Deterministically fire the request's own timeout rather than sleeping.
respond = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
const timed = fetchLatestManifest(undefined, 150);
const timer = [...timers.values()][0];
assert.equal(timer.delay, 150);
timer.run();
assert.equal(await timed, null);
assert.equal(timers.size, 0);

calls.length = 0;
respond = () => ok(release('4.0.5', 'matching latest'));
assert.equal(await fetchNotesForVersion('4.0.5', new AbortController().signal), 'matching latest');
assert.equal(calls.length, 1);
calls.length = 0;
respond = url => ok(url.endsWith('/latest') ? release('4.0.6', 'future') : release('4.0.5', 'installed'));
assert.equal(await fetchNotesForVersion('4.0.5', new AbortController().signal), 'installed');
assert.deepEqual(calls.map(call => call.url), [`${api}/latest`, `${api}/tags/v4.0.5`]);
respond = url => url.endsWith('/latest') ? Promise.reject(new Error('offline latest')) : ok(release('4.0.5', 'tag fallback'));
assert.equal(await fetchNotesForVersion('4.0.5', new AbortController().signal), 'tag fallback');
for (const bad of [release('4.0.6', 'future'), { ...release('4.0.5', 'draft'), draft: true }, release('4.0.5', ' ')]) {
  respond = () => ok(bad);
  assert.equal(await fetchNotesForVersion('4.0.5', new AbortController().signal), '');
}
calls.length = 0;
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(fetchLatestManifest(cancelled.signal), { name: 'AbortError' });
await assert.rejects(fetchNotesForVersion('4.0.5', cancelled.signal), { name: 'AbortError' });
assert.equal(calls.length, 0, 'already-cancelled requests never touch the network');
const active = new AbortController();
respond = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
const pending = fetchLatestManifest(active.signal);
active.abort();
await assert.rejects(pending, { name: 'AbortError' });
assert.equal(timers.size, 0, 'cancelled requests clear their timeout');

// Website route regression: language negotiation must not reintroduce product mirrors.
const root = new URL('../../', import.meta.url);
const workerSource = readFileSync(new URL('Web-Home/_worker.js', root), 'utf8');
const workerContext = { Request, Response, URL, fetch: (...args) => respond(...args) };
vm.runInNewContext(workerSource.replace('export default {', 'globalThis.worker = {'), workerContext);
const worker = workerContext.worker;
const assets = { ASSETS: { fetch: async () => new Response('static page') } };
const req = (path, headers = {}) => new Request(`https://sinos.example${path}`, { headers });
for (const [headers, destination] of [
  [{ 'Accept-Language': 'zh-HK,en;q=0.8' }, '/zh-hant/'],
  [{ 'Accept-Language': 'fr;q=0.5,ja;q=0.9' }, '/ja/'],
  [{ 'Accept-Language': 'ja', Cookie: 'coffee_lang=de' }, '/de/'],
]) {
  const response = await worker.fetch(req('/?from=test', headers), assets);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), `${destination}?from=test`);
}
assert.equal((await worker.fetch(req('/', { 'Accept-Language': 'ja', 'User-Agent': 'ExampleBot' }), assets)).status, 200);
assert.equal((await worker.fetch(req('/zh/docs/'), assets)).status, 200);
const sitemap = await worker.fetch(req('/sitemap.xml'), { ASSETS: { fetch: async () => new Response('<loc>/docs/</loc><xhtml:link href="/zh/"/>') } });
assert.equal(await sitemap.text(), '<loc>https://sinos.example/docs/</loc><xhtml:link href="https://sinos.example/zh/"/>');
respond = async url => {
  assert.equal(url, `${api}/latest`);
  return Response.json({ ...release('4.0.5'), assets: [] });
};
assert.equal((await (await worker.fetch(req('/version.json?platform=windows'), assets)).json()).version, '');
assert.equal((await worker.fetch(req('/download/windows'), assets)).status, 404);
respond = async url => url === `${api}/latest`
  ? Response.json({ ...release('4.0.5'), assets: [{ name: 'Sinos.CLI_4.0.5_Windows_x64-setup.exe', browser_download_url: 'https://github.com/Hopesy/Sinos/releases/download/v4.0.5/Sinos.CLI_4.0.5_Windows_x64-setup.exe' }] })
  : new Response('upstream failed', { status: 503 });
assert.equal((await worker.fetch(req('/download/windows'), assets)).status, 502, 'failed asset responses are not presented as successful installers');
for (const file of ['Web-Home/version.json', '.github/workflows/bump-version-json.yml', '.github/workflows/debug-mac.yml', '.github/workflows/mirror-release.yml']) {
  assert.equal(existsSync(new URL(file, root)), false, `${file} remains excluded`);
}
for (const ext of ['ps1', 'sh']) {
  assert.equal(readFileSync(new URL(`install/install.${ext}`, root), 'utf8'), readFileSync(new URL(`Web-Home/install.${ext}`, root), 'utf8'), 'installer copies stay synchronized');
}
console.log('PASS: Sinos-only updates, published stable versions, exact notes, timeout/cancellation, locale routes, deployment-origin sitemap and installer availability');
