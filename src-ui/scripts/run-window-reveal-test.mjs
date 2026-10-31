// Exercise the actual desktop entry with delayed IPC, commit and frame boundaries.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle = await build({ entryPoints: ['src/desktop.tsx'], bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', define: {'import.meta.env.DEV':'true'}, plugins: [{name:'startup-boundaries',setup(b){
  b.onResolve({filter:/^(react|react\/jsx-runtime|react-dom\/client|\.\/store\/app-state|\.\/App|(?:\.\/|\.\.\/\.\.\/)tauri|\.\/lib\/.*)$/},args=>({path:args.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:
    path==='react' ? 'export const StrictMode=({children})=>children; export const useEffect=globalThis.bridge.effect; export default {StrictMode,useEffect};' :
    path==='react/jsx-runtime' ? 'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;' :
    path==='react-dom/client' ? 'export default {createRoot:()=>({render:globalThis.bridge.render})};' :
    path==='./App' ? 'export function App(){globalThis.bridge.committed=true;return null;}' :
    path.includes('app-state') ? 'export const AppProvider=({children})=>children;' :
    path.includes('tool-info') ? 'export const loadToolInfo=()=>globalThis.bridge.tools;' :
    path.includes('ui-scale') ? 'export const initializeUiScale=()=>globalThis.bridge.scale;' :
    path.includes('window-focus-filter') ? 'export const onWindowForeground=()=>()=>{};export const onWindowBackground=()=>()=>{};' :
    path.includes('platform') ? 'export const IS_MACOS=false,IS_WINDOWS=true;' :
    'export const invoke=globalThis.bridge.invoke;export const commands={setBackgroundMode:()=>Promise.resolve()};'
  }));
}}]});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
for(const first of ['scale','tools']){
  let resolveTools,resolveScale,tree;const effects=[],frames=new Map(),calls=[];let frameId=0;
  const bridge={tools:new Promise(resolve=>resolveTools=resolve),scale:new Promise(resolve=>resolveScale=resolve),committed:false,
    effect:fn=>effects.push(fn),render:value=>{tree=value},invoke:async name=>{assert.equal(bridge.committed,true,'window reveal requires a committed App');calls.push(name)}};
  runInNewContext(bundle.outputFiles[0].text,{bridge,console,Promise,window:{addEventListener(){}},document:{hidden:false,documentElement:{classList:{add(){}}},getElementById:()=>({}),addEventListener(){}},requestAnimationFrame:fn=>{const id=++frameId;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id)});
  (first==='scale'?resolveScale:resolveTools)();await flush();
  assert.equal(tree,undefined,'both startup dependencies gate mounting');assert.equal(frames.size,0,'no reveal may be scheduled before mount');
  (first==='scale'?resolveTools:resolveScale)();await flush();
  assert.ok(tree);assert.equal(frames.size,0,'a scheduled React render is still awaiting commit');
  const commit=node=>{if(Array.isArray(node))node.forEach(commit);else if(node&&typeof node.type==='function')commit(node.type(node.props));};commit(tree);
  const tick=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());};
  // StrictMode setup/cleanup/setup must cancel stale frames and reveal exactly once.
  for(const effect of effects){const cleanup=effect();cleanup?.();effect();}
  tick();assert.deepEqual(calls,[]);tick();await flush();assert.deepEqual(calls,['show_main_window']);tick();assert.equal(calls.length,1);
}
console.log('OK: delayed registry/scale IPC, React commit, painted frames and StrictMode cleanup gate window reveal');
