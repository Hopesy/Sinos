import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({ entryPoints: [`${root}src/lib/pi-session.ts`], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'fixtures', setup(b) {
    b.onResolve({ filter: /^(?:react|\.\.\/tauri|\.\/session-replies|\.\/notify-prompts|@tauri-apps\/api\/event)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: {
      react: 'export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();',
      '../tauri': 'export const invoke = (...args) => globalThis.piInvoke(...args);',
      './session-replies': 'export function recordSessionReply() {} export function recordSessionQuestion() {}',
      './notify-prompts': 'export function markPromptSubmitted() {}',
      '@tauri-apps/api/event': 'export async function listen(_event, fn) { globalThis.piEvent = fn; return () => {}; }',
    }[args.path] }));
  } }],
});
let now = 1000, nextTimer = 0;
const timers = new Map();
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout, realNow = Date.now;
globalThis.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + Math.max(0, delay) }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
Date.now = () => now;
function advance(ms) {
  const end = now + ms;
  while (true) {
    const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]); now = due[1].at; due[1].fn();
  }
  now = end;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
let pendingResponse;
globalThis.piInvoke = async (command, args) => {
  if (command === 'pi_session_start') return { sessionId: 's', state: {}, models: [] };
  if (command === 'pi_session_request') return {};
  if (command === 'pi_session_close') return;
  if (command === 'pi_session_respond') return new Promise(resolve => { pendingResponse = { args, resolve }; });
  throw Error(command);
};
try {
  const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const id = 'tab';
  let release = api.retainPiSession(id, '/project');
  await tick();
  const event = value => globalThis.piEvent({ payload: { id, generation: api.getPiConnection(id).generation, event: value } });
  const ids = () => api.getPiConnection(id).state.requests.map(request => request.id);
  const dialog = (id, timeout) => ({ type: 'extension_ui_request', id, method: 'confirm', ...(timeout === undefined ? {} : { timeout }) });
  event(dialog('short', 50)); event(dialog('untimed'));
  advance(49); assert.deepEqual(ids(), ['short', 'untimed']);
  advance(1); assert.deepEqual(ids(), ['untimed'], 'expiry publishes without another stream event');
  await assert.rejects(api.respondPi(id, 'short', { confirmed: true }), /ended/, 'late replies are refused locally');
  event(dialog('zero', 0)); event(dialog('negative', -1));
  advance(1); assert.deepEqual(ids(), ['untimed', 'zero'], 'zero disables timeout and a negative delay expires immediately');
  event(dialog('settled')); event({ type: 'agent_settled' });
  assert.deepEqual(ids(), [], 'settled clears requests');
  event({ type: 'agent_start' }); event(dialog('abort')); await api.abortPi(id);
  assert.deepEqual(ids(), [], 'abort clears requests without waiting for another event');
  event(dialog('same', 40));
  const firstResponse = api.respondPi(id, 'same', { confirmed: true }); await tick();
  const firstPending = pendingResponse;
  event(dialog('same'));
  firstPending.resolve(); await firstResponse; advance(40);
  assert.deepEqual(ids(), ['same'], 'an old response or timer cannot remove a replaced dialog in the same generation');
  event({ type: 'agent_settled' });
  const backgroundGeneration = api.getPiConnection(id).generation;
  release();
  globalThis.piEvent({ payload: { id, generation: backgroundGeneration, event: dialog('background', 50) } });
  advance(50); release = api.retainPiSession(id, '/project');
  assert.deepEqual(ids(), [], 'dialogs expire while the client has no owners');
  event(dialog('old', 100));
  const oldResponse = api.respondPi(id, 'old', { confirmed: true }); await tick();
  release(); advance(300); release = api.retainPiSession(id, '/project'); await tick();
  event(dialog('old')); pendingResponse.resolve(); await oldResponse;
  advance(100);
  assert.deepEqual(ids(), ['old'], 'old response and timer cannot remove a replacement generation dialog');
  release(); advance(300);
  console.log('OK: Pi dialog expiry, abort, settlement, untimed dialogs and generation safety');
} finally {
  globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; Date.now = realNow;
}
