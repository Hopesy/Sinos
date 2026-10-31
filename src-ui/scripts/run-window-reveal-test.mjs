// Exercise the real entry's dependency wiring. Paint, StrictMode, cancellation
// and reduced motion are covered by DesktopStartup.test.tsx in the unified suite.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({ entryPoints: ['src/desktop.tsx'], bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'import.meta.env.DEV': 'true' }, plugins: [{ name: 'startup-boundaries', setup(b) {
  b.onResolve({ filter: /^(react|react\/jsx-runtime|react-dom\/client|\.\/store\/app-state|\.\/App|\.\/components\/common\/DesktopStartup|\.\/tauri|\.\/lib\/.*)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
    path === 'react' ? 'export const StrictMode=({children})=>children,Suspense=StrictMode;export function lazy(load){let Component;load().then(m=>Component=m.default);return props=>Component?.(props)}; export default {StrictMode};' :
    path === 'react/jsx-runtime' ? 'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;' :
    path === 'react-dom/client' ? 'export default {createRoot:()=>({render:globalThis.bridge.render})};' :
    path.includes('DesktopStartup') ? 'export function DesktopStartup(props){globalThis.bridge.startup=props;return null;}' :
    path === './App' ? 'export function App(){globalThis.bridge.committed=true;return null;}' :
    path.includes('app-state') ? 'export const AppProvider=({children})=>children;' :
    path.includes('tool-info') ? 'export const loadToolInfo=()=>globalThis.bridge.tools;' :
    path.includes('ui-scale') ? 'export const initializeUiScale=()=>globalThis.bridge.scale;' :
    path.includes('window-focus-filter') ? 'export const onWindowForeground=()=>()=>{};export const onWindowBackground=()=>()=>{};' :
    path.includes('platform') ? 'export const IS_MACOS=false,IS_WINDOWS=true;' :
    'export const commands={setBackgroundMode:()=>Promise.resolve()};'
  }));
} }] });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
for (const first of ['scale', 'tools', 'scale-failure']) {
  let resolveTools, resolveScale, rejectScale, tree;
  const bridge = { tools: new Promise(resolve => resolveTools = resolve), scale: new Promise((resolve, reject) => { resolveScale = resolve; rejectScale = reject; }), committed: false, render: value => { tree = value; } };
  runInNewContext(bundle.outputFiles[0].text, { bridge, console, Promise, window: { addEventListener() {} }, document: { hidden: false, documentElement: { classList: { add() {} } }, getElementById: () => ({}), addEventListener() {} } });
  assert.ok(tree, 'startup is mounted before IPC finishes');
  const commit = node => { if (node && typeof node.type === 'function') commit(node.type(node.props)); }; commit(tree);
  assert.equal(bridge.committed, false, 'workspace is passed as children without an early mount');
  let scaled = false, ready = false;
  bridge.startup.scaleReady.then(() => scaled = true); bridge.startup.ready.then(() => ready = true);
  if (first === 'scale-failure') rejectScale(new Error('zoom unavailable')); else (first === 'scale' ? resolveScale : resolveTools)();
  await flush(); assert.equal(ready, false); assert.equal(scaled, first !== 'tools');
  (first === 'tools' ? resolveScale : resolveTools)(); await flush();
  assert.equal(ready, true); assert.equal(scaled, true); commit(bridge.startup.children); assert.equal(bridge.committed, true);
}
console.log('OK: immediate startup surface, scale-before-reveal, tool-registry mount gate and graceful scale failure');
