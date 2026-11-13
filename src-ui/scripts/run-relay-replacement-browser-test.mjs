import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'sinos-relay-takeover-'));
const mock = `
window.nativeCalls=[];window.failResume=true;
window.relayFixture={relayUrl:'http://127.0.0.1:8788',inviteUrl:null,expiresAt:null,error:null,devices:[
 {pairId:'pair-111111',deviceName:'我的手机',relayUrl:'https://relay.example',online:true,state:'replaced',pairedAt:1},
 {pairId:'pair-222222',deviceName:'旧手机',relayUrl:'https://relay.example',online:false,state:'revoked',pairedAt:2}
]};
let initial=true;
export async function invoke(command,args){
 window.nativeCalls.push({command,args});
 if(command==='relay_status'){
  if(initial){initial=false;await new Promise(resolve=>window.resolveInitial=resolve)}
  return structuredClone(window.relayFixture);
 }
 if(command==='relay_resume_device'){
  await new Promise(resolve=>window.resolveResume=resolve);
  if(window.failResume)throw '接管失败，请重试';
  window.relayFixture.devices.find(device=>device.pairId===args.pairId).state='connecting';
  window.relayFixture.devices.find(device=>device.pairId===args.pairId).online=false;
  return structuredClone(window.relayFixture);
 }
 throw 'Unexpected native command: '+command;
}`;
await build({
  stdin: { loader: 'tsx', resolveDir: project, contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {RelaySettings} from './src/components/common/RelaySettings';
import './src/styles/global.css';import './src/components/common/SettingsModal.css';
createRoot(document.getElementById('root')).render(<main style={{width:'100%',maxWidth:760,boxSizing:'border-box',padding:24,margin:'auto'}}><RelaySettings /></main>);` },
  bundle: true, jsx: 'automatic', outfile: join(directory, 'fixture.js'), logLevel: 'silent',
  external: ['/fonts/*', '/backgrounds/*', '/monogram.svg'],
  plugins: [{ name: 'native-boundary', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'native', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mock, loader: 'js' }));
  } }],
});
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css') {
      response.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript');
      response.end(await readFile(join(directory, url.pathname.slice(1)))); return;
    }
    if (/^\/fonts\/[\w.-]+\.woff2$/.test(url.pathname)) {
      response.end(await readFile(join(project, 'public', url.pathname.slice(1)))); return;
    }
    if (url.pathname !== '/') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 980, height: 720 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.resolveInitial === 'function');
  assert.equal(await page.getByRole('button', { name: '连接新设备' }).isDisabled(), true);
  assert.equal(await page.getByLabel('Cloudflare 中继地址').inputValue(), '');
  assert.equal(await page.getByLabel('Cloudflare 中继地址').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '测试连接' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.nativeCalls.filter(call => call.command === 'relay_create_pairing').length), 0);
  await page.evaluate(() => window.resolveInitial());
  await page.waitForFunction(() => document.querySelector('#relay-address-input').value === 'http://127.0.0.1:8788');
  assert.equal(await page.getByRole('list', { name: '在线设备' }).count(), 0);
  await page.locator('details summary').click();
  const takeover = page.getByRole('button', { name: '在此接管 我的手机 · 111111' });
  await takeover.waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: /在此接管/ }).count(), 1);
  await page.screenshot({ path: join(directory, 'replaced.png') });
  await takeover.click();
  await page.waitForFunction(() => typeof window.resolveResume === 'function');
  assert.equal(await takeover.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '撤销 旧手机 · 222222' }).isDisabled(), true);
  await page.evaluate(() => window.resolveResume());
  await page.getByRole('alert').filter({ hasText: '接管失败，请重试' }).waitFor();
  await page.waitForFunction(() => window.nativeCalls.filter(call => call.command === 'relay_status').length >= 2);
  assert.equal(await page.evaluate(() => window.nativeCalls.filter(call => call.command === 'relay_resume_device').length), 1, 'status refresh must not retry takeover');
  assert.equal(await takeover.isEnabled(), true);
  await page.evaluate(() => { window.failResume = false; window.resolveResume = undefined; });
  await takeover.click();
  await page.waitForFunction(() => typeof window.resolveResume === 'function');
  await page.evaluate(() => window.resolveResume());
  await takeover.waitFor({ state: 'detached' });
  const calls = await page.evaluate(() => window.nativeCalls.filter(call => call.command !== 'relay_status'));
  assert.deepEqual(calls, [
    { command: 'relay_resume_device', args: { pairId: 'pair-111111' } },
    { command: 'relay_resume_device', args: { pairId: 'pair-111111' } },
  ]);
  assert.deepEqual(errors, []);
  console.log(`PASS: real relay settings interaction, scoped startup, replaced status, explicit takeover, busy/failure recovery and no automatic reclaim; artifacts: ${directory}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
