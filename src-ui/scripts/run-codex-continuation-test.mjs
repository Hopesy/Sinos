import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/lib/codex-session.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-fixture', setup(b) {
    b.onResolve({ filter: /(?:^react$|\/tauri$|^@tauri-apps\/api\/event$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react' ? 'export function useSyncExternalStore(_subscribe,snapshot) { return snapshot(); }' : args.path.includes('/event') ? 'export const listen=globalThis.bridge.listen;' : 'export const invoke=globalThis.bridge.invoke;' }));
  } }],
});
function fixture({ hold = false, legacy = false, failStartup = false, holdSend = false, controlledClose = false } = {}) {
  const calls = [], closeTimers = [];
  let listener, resumeStart, rejectSend, failTurn = false;
  const gate = new Promise(resolve => { resumeStart = resolve; });
  const pendingSend = new Promise((_resolve, reject) => { rejectSend = reject; });
  const bridge = {
    listen: async (_name, fn) => { listener = fn; return () => {}; },
    invoke: async (name, args) => {
      calls.push({ name, ...args });
      if (name === 'get_tool_control') return { ready: false, agents: [] };
      if (name === 'codex_session_start') {
        if (hold && args.id === 'new') await gate;
        if (failStartup && args.id === 'new') throw new Error('startup failed');
        return { thread: { id: `thread-${args.id}`, path: 'D:/rollout.jsonl', turns: args.id === 'old' ? [{ id: 'earlier', startedAt: Date.now() / 1000 - 13 * 3600, status: 'completed', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Earlier question' }] }, { id: 'a', type: 'agentMessage', text: 'Earlier answer' }] }] : [] }, lastContextTokens: 200000, model: 'test-model', reasoningEffort: 'medium', sandbox: { type: 'workspaceWrite', writableRoots: ['D:/Test'], networkAccess: false }, approvalPolicy: 'on-request', models: [] };
      }
      if (args.method === 'collaborationMode/list') { if (legacy) throw new Error('Unknown method'); return { data: [{ mode: 'plan' }, { mode: 'default' }] }; }
      if (args.method === 'turn/start') { if (holdSend) return pendingSend; if (failTurn) throw new Error('Send failed'); return { turn: { id: 'turn' } }; }
      return {};
    },
  };
  const module = { exports: {} };
  const fastTimeout = (fn, delay) => {
    if (controlledClose && delay === 300) { closeTimers.push(fn); return undefined; }
    return delay >= 1000 ? queueMicrotask(fn) : setTimeout(fn, delay);
  };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, bridge, crypto: { randomUUID }, setTimeout: fastTimeout, clearTimeout });
  const api = module.exports;
  return { api, calls, resumeStart, rejectSend, closeTimers, fail: value => { failTurn = value; }, state: () => api.useCodexSession('old'), emit(method, params = {}) { const start = calls.find(c => c.name === 'codex_session_start' && c.id === 'old'); listener({ payload: { id: 'old', generation: start.generation, event: { method, params: { threadId: 'thread-old', ...params } } } }); } };
}
for (const action of ['normal', 'close', 'cancel']) {
  const h = fixture({ hold: true }), old = h.api.retainCodexSession('old', 'D:/Test');
  await tick();
  assert.equal(await h.api.sendCodexInteractive('old', 'Held prompt'), true);
  assert.equal(h.state().coldReturn.prompt, 'Held prompt');
  assert.equal(h.api.continueCodexInNewThread('old', 'new'), true);
  const fresh = h.api.retainCodexSession('new', 'D:/Test'); await tick();
  assert.equal(h.api.useCodexSession('new').coldReturn?.prompt, 'Held prompt');
  if (action === 'close') fresh();
  if (action === 'cancel') assert.equal(await h.api.settleCodexColdReturn('new', 'cancel'), 'Held prompt');
  h.resumeStart(); await tick();
  assert.deepEqual(h.calls.filter(c => c.method === 'turn/start').map(c => c.params.input[0].text), action === 'normal' ? ['Held prompt'] : [], 'closing or canceling during startup never forwards the prompt');
  if (action !== 'close') fresh(); old();
}
for (const failure of ['send', 'startup']) {
  const h = fixture({ failStartup: failure === 'startup' }), prompt = '  Exact prompt\nwith whitespace  ';
  const old = h.api.retainCodexSession('old', 'D:/Test'); await tick();
  assert.equal(await h.api.sendCodexInteractive('old', prompt), true);
  assert.equal(h.api.continueCodexInNewThread('old', 'new'), true);
  if (failure === 'send') h.fail(true);
  const fresh = h.api.retainCodexSession('new', 'D:/Test');
  await tick();
  if (failure === 'startup') { assert.equal(h.calls.filter(c => c.name === 'codex_session_start' && c.id === 'new').length, 3); assert.match(h.api.useCodexSession('new').error, /startup failed/); }
  assert.equal(h.api.useCodexSession('new').coldReturn?.prompt, prompt, `${failure} keeps exact prompt recoverable in new thread`);
  assert.equal(h.calls.filter(c => c.method === 'turn/start').length, failure === 'send' ? 1 : 0, 'uncertain delivery is not retried automatically');
  if (failure === 'send') {
    h.fail(false);
    assert.equal(await h.api.settleCodexColdReturn('new', 'full'), prompt);
    assert.equal(h.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text, prompt, 'an explicit retry sends the original prompt');
    assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 2);
  } else assert.equal(await h.api.settleCodexColdReturn('new', 'cancel'), prompt, 'cancel returns the exact draft');
  old(); fresh();
}
{
  const h = fixture({ holdSend: true, controlledClose: true }), old = h.api.retainCodexSession('old', 'D:/Test'); await tick();
  await h.api.sendCodexInteractive('old', 'Old prompt');
  h.api.continueCodexInNewThread('old', 'new');
  const fresh = h.api.retainCodexSession('new', 'D:/Test'); await tick();
  assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 1);
  fresh(); h.closeTimers.shift()();
  const replacement = h.api.retainCodexSession('new', 'D:/Test'); await tick();
  h.rejectSend(new Error('late failure')); await tick();
  assert.equal(h.api.useCodexSession('new').coldReturn, undefined, 'late failure cannot restore a draft into a replacement generation');
  assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 1);
  old(); replacement();
}
{
  const h = fixture(), old = h.api.retainCodexSession('old', 'D:/Test'); await tick();
  h.api.configureCodex('old', { planMode: true });
  assert.equal(h.api.continueCodexInNewThread('old', 'new'), true);
  const fresh = h.api.retainCodexSession('new', 'D:/Test'); await tick();
  assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 0, 'manual continuation does not send an empty prompt');
  assert.equal(h.calls.find(c => c.name === 'codex_session_start' && c.id === 'new').continueFrom.reply, 'Earlier answer');
  assert.equal(h.api.useCodexSession('new').planMode, true, 'a fresh handoff cannot silently turn planning into execution');
  await h.api.sendCodexMessage('new', 'Continue planning');
  assert.equal(h.calls.find(c => c.method === 'turn/start').params.sandboxPolicy.type, 'readOnly');
  old(); fresh();
}
for (const status of ['completed', 'interrupted', 'failed']) {
  const h = fixture(), release = h.api.retainCodexSession('old', 'D:/Test'); await tick();
  assert.equal(h.state().planSupported, true);
  h.api.configureCodex('old', { planMode: true });
  await h.api.sendCodexMessage('old', 'Make a plan');
  const request = h.calls.find(c => c.method === 'turn/start');
  assert.equal(request.params.collaborationMode.mode, 'plan');
  assert.equal(request.params.collaborationMode.settings.developer_instructions, null);
  assert.equal(request.params.sandboxPolicy.type, 'readOnly'); assert.equal(request.params.approvalPolicy, 'never');
  assert.equal(await h.api.approveCodexPlan('old', 'Implement'), false, 'approval is unavailable during planning');
  h.emit('item/completed', { turnId: 'turn', item: { id: 'plan', type: 'plan', text: '1. Fix it' } });
  h.emit('turn/completed', { turn: { id: 'turn', status } });
  if (status !== 'completed') assert.equal(await h.api.approveCodexPlan('old', 'Implement'), false);
  else {
    assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 1, 'finishing a plan never automatically implements it');
    h.fail(true); assert.equal(await h.api.approveCodexPlan('old', 'Implement'), false); assert.equal(h.state().planMode, true); assert.equal(h.state().planReady, 'turn');
    h.fail(false); assert.equal(await h.api.approveCodexPlan('old', 'Implement'), true);
    const execution = h.calls.filter(c => c.method === 'turn/start').at(-1).params;
    assert.equal(execution.collaborationMode.mode, 'default'); assert.equal(execution.sandboxPolicy.type, 'workspaceWrite'); assert.equal(execution.sandboxPolicy.writableRoots[0], 'D:/Test'); assert.equal(execution.approvalPolicy, 'on-request');
    assert.equal(await h.api.approveCodexPlan('old', 'Duplicate'), false);
  }
  release();
}
{
  const h = fixture(), release = h.api.retainCodexSession('old', 'D:/Test'); await tick();
  assert.equal(await h.api.sendCodexMessage('old', '/plan'), true);
  assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 0, 'a mode switch does not start a model task');
  assert.equal(await h.api.sendCodexMessage('old', '/plan Explain the migration'), true);
  const request = h.calls.find(c => c.method === 'turn/start').params;
  assert.equal(request.input[0].text, 'Explain the migration'); assert.equal(request.collaborationMode.mode, 'plan'); assert.equal(request.sandboxPolicy.type, 'readOnly');
  release();
}
{
  const h = fixture({ legacy: true }), release = h.api.retainCodexSession('old', 'D:/Test'); await tick();
  assert.equal(h.state().ready, true); assert.equal(h.state().planSupported, undefined);
  h.api.configureCodex('old', { planMode: true }); assert.equal(h.state().planMode, undefined);
  assert.equal(await h.api.sendCodexMessage('old', '/plan Explain the migration'), false, 'unsupported planning cannot silently become an execution prompt');
  assert.equal(await h.api.sendCodexMessage('old', 'Normal chat'), true); assert.equal(h.calls.find(c => c.method === 'turn/start').params.collaborationMode, undefined);
  release();
}
console.log('OK: continuation lifetime, manual handoff, read-only planning, explicit approval, permission restoration, failed/interrupted plans, retry and legacy fallback');
