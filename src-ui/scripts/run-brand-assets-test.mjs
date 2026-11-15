import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = await build({
  stdin: { contents: "export * from './src/lib/file-icons'; export { ICON_ART_THEMES } from './src/lib/personalization';", resolveDir: path.join(root, 'src-ui') },
  bundle: true, platform: 'node', format: 'cjs', write: false,
});
const module = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports });
const { getFileIconSrc, ICON_ART_THEMES } = module.exports;

// Existing saved theme selections must resolve to the replacement artwork in every consumer.
assert.equal(getFileIconSrc('TS', 'coffee'), '/icons/themes/sinos/ts.svg');
assert.equal(getFileIconSrc('unknown', 'coffee'), '/icons/themes/sinos/file.svg');
const brandTheme = ICON_ART_THEMES.find(theme => theme.id === 'coffee');
assert.equal(brandTheme.label, 'Sinos');
assert.equal(brandTheme.folderSrc, '/icons/themes/sinos/folder-closed.svg');
for (const theme of ICON_ART_THEMES) {
  for (const url of [theme.folderSrc, getFileIconSrc('rs', theme.id), getFileIconSrc('unknown', theme.id)]) {
    assert.ok(fs.existsSync(path.join(root, 'src-ui/public', url)), `Missing theme artwork: ${url}`);
  }
}
for (const retired of ['icons/android', 'icons/ios', 'icons/StoreLogo.png', 'icons/Square150x150Logo.png',
  'icons/icon-source-unix.png', 'icons/icon-source-windows.png', 'scripts/rebuild-icons.py', 'src-ui/public/icons/themes/coffee',
  'Web-Home/demo/wallpaper.jpg', 'Web-Home/demo/multi-tab.gif']) {
  assert.equal(fs.existsSync(path.join(root, retired)), false, `Retired brand asset remains: ${retired}`);
}
const app = JSON.parse(fs.readFileSync(path.join(root, 'tauri.conf.json'), 'utf8'));
for (const icon of app.bundle.icon) assert.ok(fs.existsSync(path.join(root, icon)), `Missing packaged icon: ${icon}`);
assert.deepEqual(fs.readFileSync(path.join(root, 'src-ui/public/remote-icon.png')),
  fs.readFileSync(path.join(root, 'icons/256x256.png')), 'Mobile home-screen artwork must use the current Sinos mark');
const home = fs.readFileSync(path.join(root, 'Web-Home/index.html'), 'utf8');
assert.ok(home.includes('/demo/sinos-workspace.webp'));
assert.ok(fs.existsSync(path.join(root, 'Web-Home/demo/sinos-workspace.webp')));
for (const locale of ['', 'zh/', 'zh-hant/']) {
  const docs = fs.readFileSync(path.join(root, 'Web-Home', locale, 'docs/index.html'), 'utf8');
  assert.ok(docs.includes('apt remove sinos-cli'));
  assert.ok(!docs.includes('remove coffee-cli'));
}
// Run the real generator against an isolated brand source to catch stale generated artwork.
const artifacts = path.join(root, '.Sinos-temp');
fs.mkdirSync(artifacts, { recursive: true });
const fixture = fs.mkdtempSync(path.join(artifacts, 'brand-icons-'));
try {
  for (const relative of ['scripts/generate-icon-themes.mjs', 'icons/branding/sinos-icon.svg']) {
    const target = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  const generated = spawnSync(process.execPath, [path.join(fixture, 'scripts/generate-icon-themes.mjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const relative = 'src-ui/public/icons/themes/sinos';
  const files = fs.readdirSync(path.join(fixture, relative)).sort();
  assert.equal(files.length, 19);
  assert.deepEqual(files, fs.readdirSync(path.join(root, relative)).sort());
  for (const file of files) assert.deepEqual(fs.readFileSync(path.join(fixture, relative, file)), fs.readFileSync(path.join(root, relative, file)), `Regenerate ${file}`);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log('PASS: saved theme compatibility, real icon generation, active asset references, retired artwork and Sinos documentation.');
