// Manual benchmark: real conversation components, synthetic transcripts, no CLI processes.
// Run from src-ui: node scripts/benchmark-session-memory.mjs [output.json]
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const project = fileURLToPath(new URL('..', import.meta.url));
const sourceRef = process.env.SINOS_MEMORY_REF;
const revision = execFileSync('git', ['rev-parse', '--verify', sourceRef ?? 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
const directory = await mkdtemp(join(tmpdir(), 'sinos-memory-'));
let browser, server;
try {
  await build({
    stdin: { resolveDir: project, loader: 'tsx', contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {ClaudeConversation} from './src/components/center/ClaudeConversation';
      import './src/styles/global.css';import './src/components/center/TierTerminal.css';
      function Fixture(){const [count,setCount]=useState(0),[active,setActive]=useState(0);
        window.setCount=setCount;window.setActive=setActive;
        return Array.from({length:count},(_,i)=><div key={i} className="host" data-session={i} style={{display:active===i?'flex':'none'}}>
          <ClaudeConversation sessionId={String(i)} cwd="D:/Test" isActive={active===i}/></div>)}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` },
    bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
    external: ['/fonts/*', '/monogram.svg'], nodePaths: [join(project, 'node_modules')],
    loader: { '.webp': 'dataurl', '.webm': 'dataurl', '.gif': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'isolated-session', setup(builder) {
      if (sourceRef) builder.onLoad({ filter: /[\\/]center[\\/](ClaudeConversation\.tsx|MarkdownContent\.tsx|conversation-virtualizer\.ts)$/ }, args => ({
        contents: execFileSync('git', ['show', `${revision}:src-ui/src/components/center/${args.path.split(/[\\/]/).at(-1)}`], { cwd: project, encoding: 'utf8' }),
        loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
      }));
      for (const [filter, path] of [[/(^|\/)tauri$/, 'tauri'], [/claude-session$/, 'session'], [/store\/app-state$/, 'store'], [/lib\/shiki$/, 'syntax'], [/(^|\/)clipboard$/, 'clipboard']]) {
        builder.onResolve({ filter }, () => ({ path, namespace: 'fixture' }));
      }
      builder.onResolve({ filter: /\.svg\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?raw', '')), namespace: 'svg' }));
      builder.onLoad({ filter: /.*/, namespace: 'svg' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: project, loader: 'js', contents: args.path === 'store' ? `
        export function useAppLanguage(){return 'en'};export function useAppState(){return {dispatch(){}}};
      ` : args.path === 'syntax' ? `
        export async function tokenizeFile(){return null};export async function tokenizeByLang(){return null};export function getShikiTheme(){return 'light'};
      ` : args.path === 'clipboard' ? `
        export async function clipboardWrite(){};export async function clipboardRead(){return ''};
      ` : args.path === 'tauri' ? `export const commands=new Proxy({},{get:()=>async()=>{}});` : `
        import {useSyncExternalStore} from 'react';import {emptyClaudeState} from './src/lib/claude-protocol';
        const sessions=new Map();
        function get(id){if(!sessions.has(id))sessions.set(id,{...emptyClaudeState(),ready:true,messages:Array.from({length:96},(_,i)=>({
          id:id+'-'+i,role:i%2?'assistant':'user',timestamp:1700000000000+i,
          content:i%2?'Session '+id+' message '+i+'\\n\\n'+Array.from({length:70},(_,j)=>'- **Item '+j+'**: text with [a link](https://example.com) and \\x60code\\x60.').join('\\n'):'Prompt '+id+'-'+i
        }))});return sessions.get(id)}
        export function useClaudeSession(id){return useSyncExternalStore(()=>()=>{},()=>get(id))};
        export function retainClaudeSession(){return()=>{}};export async function controlClaude(){};export async function respondClaude(){};export async function loadClaudeHistory(){};
      ` }));
    } }],
  });
  server = http.createServer(async (req, res) => {
    if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(`<!doctype html><link rel="stylesheet" href="/fixture.css"><style>*{box-sizing:border-box}body{margin:0}:root{--font:Arial;--mono:monospace}#root,.host{height:100vh}.host{width:100%}</style><div id="root"></div><script src="/fixture.js"></script>`);
    const name = req.url.slice(1);
    if (!['fixture.js', 'fixture.css'].includes(name)) return res.writeHead(404).end();
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css');
    res.end(await readFile(join(directory, name)));
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const cdp = await page.context().newCDPSession(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.setCount);
  const results = [];
  for (const count of [0, 1, 4, 8]) {
    await page.evaluate(count => window.setCount(count), count);
    // Visit every session before measuring the one-visible, others-hidden state.
    for (let index = 0; index < count; index++) {
      await page.evaluate(index => window.setActive(index), index);
      await page.waitForFunction(index => document.querySelector(`[data-session="${index}"] .claude-row`), index);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(250);
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    results.push({ sessions: count, usedHeapBytes: heap.usedSize, nodes: dom.nodes,
      ...await page.evaluate(() => ({ markdownElements: document.querySelectorAll('.md-body *').length, hiddenMarkdownElements: [...document.querySelectorAll('.host')].filter(el=>el.style.display==='none').reduce((n,el)=>n+el.querySelectorAll('.md-body *').length,0) })) });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const report = { source: sourceRef ? revision : `working tree based on ${revision}`, workload: '96 messages per session, 48 Markdown replies with 70 list items each; each tab visited; one visible; production React; syntax highlighting stubbed; GC before samples', results };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  for (const name of ['fixture.js', 'fixture.css']) await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(directory);
}
