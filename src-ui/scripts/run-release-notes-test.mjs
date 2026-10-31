import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const bundled = readFileSync(new URL('../../install/release-notes-template.md', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/lib/release-notes.ts', import.meta.url), 'utf8');
const values = new Map(), calls = [];
let respond;
const context = {
  exports: {}, require: () => ({ default: bundled }),
  localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
  fetch: async (url, options) => { calls.push({ url, signal: options.signal }); return respond(url); },
};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const { BUNDLED_VERSION, shouldShowReleaseNotes, notesForLocale, cachedReleaseNotes, loadReleaseNotes } = context.exports;
const version = BUNDLED_VERSION;
assert.equal(version, readFileSync(new URL('../../Cargo.toml', import.meta.url), 'utf8').match(/^version = "([^"]+)"/m)[1], 'bundled release notes match the application version');
for (const locale of ['zh-CN', 'en', 'zh-TW', 'ja', 'ko']) {
  const section = notesForLocale(bundled, locale);
  assert.ok(section.startsWith(`### Sinos CLI v${version}`), `${locale} release header matches the application version`);
  assert.ok(section.includes('\n- '), `${locale} release notes contain update details`);
}
for (const [current, seen, expected] of [
  ['3.6.7', null, true], ['3.6.7', '3.6.6', true], ['3.6.7', '3.6.7', false],
  ['3.6.7', '3.6.8', false], ['3.7.0', '3.6.9', true], ['4.0.0', '3.9.9', true],
  ['3.6.7', 'bad', true], ['', null, false], ['invalid', null, false],
]) assert.equal(shouldShowReleaseNotes(current, seen), expected, `${current} after ${seen}`);
const multilingual = ['简体中文', 'English', '繁體中文', '日本語', '한국어'].map((label, i) => `<details open>\n<summary><b>${label}</b></summary>\n\nnotes-${i}\n</details>`).join('\n');
for (const [locale, expected] of [['zh-CN',0],['en',1],['zh-TW',2],['ja',3],['ko',4],['de',1]]) assert.equal(notesForLocale(multilingual,locale),`notes-${expected}`);
assert.equal(notesForLocale(' Plain markdown ', 'en'), 'Plain markdown');
assert.equal(notesForLocale('', 'en'), '');
assert.equal(cachedReleaseNotes(version), bundled, 'offline first launch has bundled notes');
assert.equal(cachedReleaseNotes('99.0.0'), '', 'bundled notes cannot be shown as another version');
values.set('cc-release-notes', '{bad');
assert.equal(cachedReleaseNotes(version), bundled, 'corrupt cache retains bundled fallback');
const response = body => ({ ok: true, json: async () => body });
const signal = new AbortController().signal;
respond = () => response({ tag_name: `v${version}`, body: multilingual });
assert.equal(await loadReleaseNotes(version,signal),multilingual);
assert.equal(calls.length,1,'matching manifest needs no extra request');
assert.equal(cachedReleaseNotes(version),multilingual,'remote notes persist for offline viewing');
calls.length=0;
respond = url => response(url.endsWith('/latest') ? {version:'99.0.0',releaseNotes:'future notes'} : {tag_name:`v${version}`,body:'installed notes',draft:false});
assert.equal(await loadReleaseNotes(version,signal),'installed notes');
assert.equal(calls.length,2);
assert.ok(calls[1].url.endsWith(`/tags/v${version}`),'fetch the installed release rather than the latest one');
calls.length=0;
respond = url => { if(url.endsWith('/latest'))throw new Error('offline manifest');return response({tag_name:`v${version}`,body:'direct notes'}); };
assert.equal(await loadReleaseNotes(version,signal),'direct notes','exact release fallback survives a manifest failure');
for(const badRelease of [{tag_name:'v99.0.0',body:'future'}, {tag_name:`v${version}`,body:'draft',draft:true}, {tag_name:`v${version}`,body:''}]) {
  respond = url => response(url.endsWith('/latest')?{version}:badRelease);
  await assert.rejects(loadReleaseNotes(version,signal));
  assert.equal(cachedReleaseNotes(version),'direct notes','failed refresh cannot erase the last good cache');
}
respond = () => {throw new Error('offline')};
await assert.rejects(loadReleaseNotes(version,signal));
assert.equal(cachedReleaseNotes(version),'direct notes');
calls.length=0;
const cancelled = new AbortController();cancelled.abort();
await assert.rejects(loadReleaseNotes(version,cancelled.signal));
assert.equal(calls.length,1,'cancellation prevents the fallback request');
console.log('PASS: release version baseline, locale selection, offline bundle/cache, exact-version fallback, failure preservation and cancellation');
