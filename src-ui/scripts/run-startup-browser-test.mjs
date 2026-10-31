// Real startup component and theme CSS, with controlled native startup completion.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'sinos-startup-'));
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React from 'react';import {createRoot} from 'react-dom/client';import {DesktopStartup} from './src/components/common/DesktopStartup';import './src/styles/global.css';
  const p=new URLSearchParams(location.search);document.documentElement.dataset.theme=p.get('theme')||'obsidian';document.documentElement.dataset.mode=p.get('mode')||'dark';localStorage.setItem('cc-lang',p.get('lang')||'zh-CN');
  const ready=new Promise(resolve=>window.completeStartup=resolve);window.reveals=0;
  createRoot(document.getElementById('root')).render(<React.StrictMode><DesktopStartup ready={ready} scaleReady={Promise.resolve()}><div className="fixture-workspace" style={{flex:1,display:'grid',placeItems:'center'}}><button>Workspace ready</button></div></DesktopStartup></React.StrictMode>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', external: ['/fonts/*', '/monogram.svg'], plugins: [{ name: 'native-fixture', setup(b) {
  b.onResolve({ filter: /\/tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onResolve({ filter: /\/platform$/ }, () => ({ path: 'platform', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'platform' ? 'export const IS_MACOS=false;' : 'export const isTauri=false;export const commands={};export async function invoke(){window.reveals++;}' }));
  b.onResolve({ filter: /\.svg\?raw$/ }, a => ({ path: resolve(a.resolveDir, a.path.replace('?raw', '')), namespace: 'svg' }));
  b.onLoad({ filter: /.*/, namespace: 'svg' }, async a => ({ contents: `export default ${JSON.stringify(await readFile(a.path, 'utf8'))}` }));
} }] });
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'); return; }
    const file = ['/fixture.js', '/fixture.css'].includes(path) ? join(directory, path.slice(1)) : path.startsWith('/fonts/') ? join(root, 'public/fonts', path.split('/').pop()) : null;
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'font/woff2'); res.end(await readFile(file));
  } catch { res.writeHead(500).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  for (const [name, width, height, mode, lang] of [['dark', 1280, 800, 'dark', 'zh-CN'], ['light', 900, 600, 'light', 'en'], ['scaled', 600, 400, 'dark', 'ja']]) {
    await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}&lang=${lang}`);
    await page.waitForFunction(() => window.reveals === 1);
    await page.evaluate(() => document.fonts.ready);
    // Settle only the decorative entrance, leaving startup completion pending.
    await page.evaluate(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).forEach(a => a.finish()));
    const layout = await page.evaluate(() => {
      const inside = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; };
      return { fits: ['.startup-header', '.startup-mark', '#startup-brand', '.startup-status', '.startup-footer'].every(inside), workspace: !!document.querySelector('.fixture-workspace'), color: getComputedStyle(document.querySelector('.desktop-startup')).backgroundColor };
    });
    assert.equal(layout.fits, true, `${name}: startup content fits the window`); assert.equal(layout.workspace, false);
    await page.screenshot({ path: join(directory, `${name}.png`) });
    await page.evaluate(() => window.completeStartup());
    await page.waitForSelector('.desktop-startup', { state: 'detached' });
    assert.equal(await page.locator('.desktop-workspace').getAttribute('inert'), null);
    assert.ok((await page.locator('.fixture-workspace').boundingBox()).height >= height - 1, 'workspace retains full root height');
    assert.equal(await page.evaluate(() => window.reveals), 1);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload(); await page.waitForFunction(() => window.reveals === 1);
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  await page.evaluate(() => window.completeStartup()); await page.waitForSelector('.desktop-startup', { state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('OK: startup dark/light/scaled layouts, real paint, single reveal, full-height workspace handoff and reduced motion');
  console.log(`Screenshots: ${directory}`);
} finally {
  await browser.close(); await new Promise(done => server.close(done));
  for (const file of ['fixture.js', 'fixture.css']) await unlink(join(directory, file));
  await rmdir(directory).catch(() => {}); // Keep visual evidence when screenshots were written.
}
