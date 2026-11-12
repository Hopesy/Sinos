import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/lib/claude-session.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-fixture', setup(b) {
    b.onResolve({ filter: /(?:^react$|\/tauri$|^@tauri-apps\/api\/event$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react' ? 'export function useSyncExternalStore() {}' : args.path.includes('/event') ? 'export async function listen() { return () => {}; }' : 'export const invoke = globalThis.nativeInvoke;' }));
  } }],
});

for (const action of ['normal', 'close', 'cancel']) {
  const calls = [];
  let resumeStart;
  const startGate = new Promise(resolve => { resumeStart = resolve; });
  const nativeInvoke = async (name, args) => {
    calls.push({ name, ...args });
    if (name === 'get_tool_control') return { ready: false, agents: [] };
    if (name === 'claude_session_start') {
      if (args.id === 'new') await startGate;
      const timestamp = new Date(Date.now() - 180 * 60_000).toISOString();
      const history = [
        { type: 'user', uuid: 'user', timestamp, message: { content: 'Earlier question' } },
        { type: 'assistant', uuid: 'answer', timestamp, message: { id: 'message', content: [{ type: 'text', text: 'Earlier answer' }], usage: { input_tokens: 200000 } } },
      ];
      return { sessionId: randomUUID(), initialization: {}, history: { data: args.id === 'old' ? history.map(row => JSON.stringify(row)).join('\n') : '', cursor: 0 } };
    }
    if (name === 'claude_session_control') return { applied: {}, effective: {} };
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, nativeInvoke, crypto: { randomUUID }, setTimeout, clearTimeout });
  const api = module.exports, releaseOld = api.retainClaudeSession('old', 'D:/Test');
  await tick();
  assert.equal(api.getClaudeSession('old').ready, true);
  assert.equal(await api.sendClaudeInteractive('old', 'Held prompt'), true);
  assert.equal(api.getClaudeSession('old').coldReturn.prompt, 'Held prompt');
  assert.equal(api.continueClaudeInNewConversation('old', 'new'), true);
  const releaseNew = api.retainClaudeSession('new', 'D:/Test');
  await tick();
  assert.ok(calls.some(call => call.name === 'claude_session_start' && call.id === 'new'));
  assert.equal(api.getClaudeSession('new').coldReturn?.prompt, 'Held prompt');
  if (action === 'close') releaseNew();
  if (action === 'cancel') assert.equal(await api.settleClaudeColdReturn('new', 'cancel'), 'Held prompt');
  resumeStart();
  await tick();
  assert.deepEqual(calls.filter(call => call.name === 'claude_session_send').map(call => call.text), action === 'normal' ? ['Held prompt'] : [], 'closing or canceling during startup never forwards the prompt');
  if (action !== 'close') releaseNew();
  releaseOld();
}
for (const failure of ['send', 'startup']) {
  const calls = [], prompt = '  Exact prompt\nwith whitespace  ';
  let rejectSend = failure === 'send';
  const nativeInvoke = async (name, args) => {
    calls.push({ name, ...args });
    if (name === 'get_tool_control') return { ready: false, agents: [] };
    if (name === 'claude_session_start') {
      if (args.id === 'new' && failure === 'startup') throw new Error('startup failed');
      const timestamp = new Date(Date.now() - 180 * 60_000).toISOString();
      const history = [{ type: 'user', uuid: 'u', timestamp, message: { content: 'Earlier question' } }, { type: 'assistant', uuid: 'a', timestamp, message: { id: 'm', content: [{ type: 'text', text: 'Earlier answer' }], usage: { input_tokens: 200000 } } }];
      return { sessionId: randomUUID(), initialization: {}, history: { data: args.id === 'old' ? history.map(row => JSON.stringify(row)).join('\n') : '', cursor: 0 } };
    }
    if (name === 'claude_session_control') return { applied: {}, effective: {} };
    if (name === 'claude_session_send' && rejectSend) throw new Error('send failed');
  };
  const module = { exports: {} };
  const fastTimeout = (fn, delay) => delay >= 1000 ? queueMicrotask(fn) : setTimeout(fn, delay);
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, nativeInvoke, crypto: { randomUUID }, setTimeout: fastTimeout, clearTimeout });
  const api = module.exports, old = api.retainClaudeSession('old', 'D:/Test'); await tick();
  assert.equal(await api.sendClaudeInteractive('old', prompt), true);
  assert.equal(api.continueClaudeInNewConversation('old', 'new'), true);
  const fresh = api.retainClaudeSession('new', 'D:/Test');
  await tick();
  if (failure === 'startup') { assert.equal(calls.filter(c => c.name === 'claude_session_start' && c.id === 'new').length, 3); assert.equal(api.getClaudeSession('new').status, 'error'); }
  assert.equal(api.getClaudeSession('new').coldReturn?.prompt, prompt, `${failure} keeps exact prompt recoverable in new conversation`);
  assert.equal(calls.filter(c => c.name === 'claude_session_send').length, failure === 'send' ? 1 : 0, 'uncertain delivery is not retried automatically');
  if (failure === 'send') {
    rejectSend = false;
    assert.equal(await api.settleClaudeColdReturn('new', 'full'), prompt);
    assert.equal(calls.filter(c => c.name === 'claude_session_send').at(-1).text, prompt, 'an explicit retry sends the original prompt');
    assert.equal(calls.filter(c => c.name === 'claude_session_send').length, 2);
  } else assert.equal(await api.settleClaudeColdReturn('new', 'cancel'), prompt, 'cancel returns the exact draft');
  old(); fresh();
}
{
  const calls = [], closeTimers = [];
  let rejectSend;
  const pendingSend = new Promise((_resolve, reject) => { rejectSend = reject; });
  const nativeInvoke = async (name, args) => {
    calls.push({ name, ...args });
    if (name === 'get_tool_control') return { ready: false, agents: [] };
    if (name === 'claude_session_start') {
      const timestamp = new Date(Date.now() - 180 * 60_000).toISOString();
      const history = [{ type: 'user', uuid: 'u', timestamp, message: { content: 'Earlier question' } }, { type: 'assistant', uuid: 'a', timestamp, message: { id: 'm', content: [{ type: 'text', text: 'Earlier answer' }], usage: { input_tokens: 200000 } } }];
      return { sessionId: randomUUID(), initialization: {}, history: { data: args.id === 'old' ? history.map(row => JSON.stringify(row)).join('\n') : '', cursor: 0 } };
    }
    if (name === 'claude_session_control') return { applied: {}, effective: {} };
    if (name === 'claude_session_send') return pendingSend;
  };
  const module = { exports: {} };
  const controlledTimeout = (fn, delay) => { if (delay === 300) { closeTimers.push(fn); return undefined; } return setTimeout(fn, delay); };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, nativeInvoke, crypto: { randomUUID }, setTimeout: controlledTimeout, clearTimeout });
  const api = module.exports, old = api.retainClaudeSession('old', 'D:/Test'); await tick();
  await api.sendClaudeInteractive('old', 'Old prompt');
  api.continueClaudeInNewConversation('old', 'new');
  const fresh = api.retainClaudeSession('new', 'D:/Test'); await tick();
  assert.equal(calls.filter(c => c.name === 'claude_session_send').length, 1);
  fresh(); closeTimers.shift()();
  const replacement = api.retainClaudeSession('new', 'D:/Test'); await tick();
  rejectSend(new Error('late failure')); await tick();
  assert.equal(api.getClaudeSession('new').coldReturn, undefined, 'late failure cannot restore a draft into a replacement generation');
  assert.equal(calls.filter(c => c.name === 'claude_session_send').length, 1);
  old(); replacement();
}
console.log('OK: held continuation forwards once; failures preserve the draft; closing during startup never submits a task');
