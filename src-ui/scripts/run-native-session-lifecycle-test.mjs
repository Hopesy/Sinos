import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundles = new Map();
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture(tool, native, listenFailures = 0) {
  if (!bundles.has(tool)) {
    const out = await build({ entryPoints: [`src/lib/${tool}-session.ts`], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'native-boundaries', setup(b) {
      b.onResolve({ filter: /(?:^react$|\/tauri$|^@tauri-apps\/api\/event$|^\.\/session-replies$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'react' ? 'export const useSyncExternalStore=(_s,get)=>get();' : path.includes('/event') ? 'export async function listen(name,fn){if(globalThis.bridge.listenFailures-->0)throw Error("listener temporarily unavailable");globalThis.bridge.listeners.set(name,fn);return()=>{};}' : path.endsWith('session-replies') ? 'export const recordSessionReply=(...args)=>globalThis.bridge.replies.push(args);export const recordSessionQuestion=(...args)=>globalThis.bridge.questions.push(args);' : 'export const invoke=globalThis.bridge.invoke;' }));
    } }] });
    bundles.set(tool, out.outputFiles[0].text);
  }
  const timers = new Map(); let timer = 0;
  const bridge = { calls: [], listeners: new Map(), replies: [], questions: [], listenFailures, invoke: async (command, args) => {
    bridge.calls.push({ ...args, command, request: args?.command });
    if (command === 'get_tool_control') return { ready: false, agents: [] };
    if (command === 'claude_session_control') return { applied: {}, effective: {} };
    return native(command, args);
  } };
  const module = { exports: {} };
  runInNewContext(bundles.get(tool), { module, exports: module.exports, bridge, crypto: { randomUUID }, console, setTimeout: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout: id => timers.delete(id) });
  const name = tool === 'dsh' ? 'Dsh' : tool === 'opencode' ? 'OpenCode' : tool[0].toUpperCase() + tool.slice(1);
  return { api: module.exports, ...bridge,
    retain: resume => module.exports[`retain${name}Session`]('tab', 'D:/fixture', resume),
    connection: () => module.exports[`get${name}Connection`]('tab'),
    fire(ms) { for (const [id, value] of [...timers]) if (value.ms === ms) { timers.delete(id); value.fn(); } },
    emit(generation, event) { bridge.listeners.get(`${tool}-session-event`)({ payload: { id: 'tab', generation, event } }); },
  };
}
const resultFor = tool => tool === 'claude' ? { sessionId: 'native', history: { data: '', cursor: 0 }, initialization: { models: [], commands: [] } } : tool === 'codex' ? { thread: { id: 'native', turns: [] }, models: [] } : tool === 'opencode' ? { session: { id: 'native' }, messages: [], models: [], permissions: [], forms: [] } : tool === 'pi' ? { sessionId: 'native', state: {}, messages: [], models: [] } : { sessionId: 'native', route: { provider: 'p', model: 'm' }, models: [] };
let failed = 0, passed = 0;
async function test(name, run) { try { await run(); passed++; console.log('OK:', name); } catch (error) { failed++; console.error('FAIL:', name, error); } }

for (const tool of ['claude', 'codex', 'dsh', 'opencode', 'pi']) {
  await test(`${tool}: live questions notify once and reject stale generations`, async () => {
    let generation;
    const f = await fixture(tool, async (command, args) => { if (command.endsWith('_start')) { generation = args.generation; return resultFor(tool); } return {}; });
    const release = f.retain(); await flush();
    const event = tool === 'claude' ? { type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } }
      : tool === 'opencode' ? { type: 'form.created', data: { form: { id: 'ask', sessionID: 'native', questions: [] } } }
      : tool === 'pi' ? { type: 'extension_ui_request', id: 'ask', method: 'confirm', title: 'Proceed?' }
      : { id: 'ask', method: tool === 'codex' ? 'item/tool/requestUserInput' : 'user-question/ask', params: { threadId: 'native', sessionId: 'native', questions: [] } };
    f.emit('obsolete', event); assert.equal(f.questions.length, 0);
    f.emit(generation, event); f.emit(generation, event);
    assert.equal(f.questions.length, 1, 'repeated events for an outstanding question do not repeat alerts');
    release(); f.fire(300); await flush();
  });
  await test(`${tool}: event subscription recovers after its first failure`, async () => {
    const f = await fixture(tool, async command => command.endsWith('_start') ? resultFor(tool) : {}, 1);
    let release = f.retain(); await flush();
    if (tool === 'dsh') { release(); f.fire(300); await flush(); release = f.retain(); }
    else f.fire(1000);
    await flush();
    assert.equal(f.connection()?.ready, true, 'a failed listener must not poison future connections');
    release(); f.fire(300); await flush();
  });
  await test(`${tool}: close cancels pending startup and cleans late registration`, async () => {
    const start = deferred(), live = new Set();
    const f = await fixture(tool, async (command, args) => {
      if (command.endsWith('_start')) { await start.promise; live.add(args.generation); return resultFor(tool); }
      if (command.endsWith('_close')) live.delete(args.generation);
      return {};
    });
    const release = f.retain(); await flush();
    release(); f.fire(300); await flush();
    assert.equal(f.calls.filter(c => c.command.endsWith('_close')).length, 1, 'cancel before initialization resolves');
    start.resolve(); await flush();
    assert.equal(live.size, 0, 'late registration is cleaned');
    assert.equal(f.connection(), undefined);
    f.fire(1000); f.fire(2000); await flush();
    assert.equal(f.calls.filter(c => c.command.endsWith('_start')).length, 1, 'closed clients never retry');
  });
  await test(`${tool}: StrictMode retain preserves a pending connection`, async () => {
    const start = deferred();
    const f = await fixture(tool, async command => command.endsWith('_start') ? start.promise : {});
    const first = f.retain(); await flush(); first(); const release = f.retain(); f.fire(300);
    assert.equal(f.calls.filter(c => c.command.endsWith('_close')).length, 0);
    start.resolve(resultFor(tool)); await flush(); assert.equal(f.connection().ready, true);
    release(); f.fire(300); await flush();
  });
  await test(`${tool}: late startup failure after close never retries`, async () => {
    const start = deferred();
    const f = await fixture(tool, async command => command.endsWith('_start') ? start.promise : {});
    const release = f.retain(); await flush(); release(); f.fire(300); await flush();
    start.reject(new Error('late initialization failure')); await flush();
    f.fire(1000); f.fire(2000); await flush();
    assert.equal(f.calls.filter(c => c.command.endsWith('_start')).length, 1);
    assert.equal(f.connection(), undefined);
  });
  await test(`${tool}: late old startup preserves a replacement with the same tab ID`, async () => {
    const old = deferred(), live = new Set(); let starts = 0;
    const f = await fixture(tool, async (command, args) => {
      if (command.endsWith('_start')) { if (++starts === 1) await old.promise; live.add(args.generation); return resultFor(tool); }
      if (command.endsWith('_close')) live.delete(args.generation);
      return {};
    });
    const first = f.retain(); await flush(); first(); f.fire(300); await flush();
    const release = f.retain(); await flush(); const generation = f.connection().generation;
    old.resolve(); await flush();
    assert.deepEqual([...live], [generation]); assert.equal(f.connection().ready, true);
    release(); f.fire(300); await flush();
  });
}
for (const action of ['model switch', 'stop']) await test(`DeepSeek: close during ${action} cleans a late runtime`, async () => {
  let starts = 0; const gate = deferred(), live = new Set();
  const f = await fixture('dsh', async (command, args) => {
    if (command === 'dsh_session_start') { if (++starts > 1) await gate.promise; live.add(args.generation); return resultFor('dsh'); }
    if (command === 'dsh_session_close') live.delete(args.generation);
    return {};
  });
  const release = f.retain(); await flush();
  const change = action === 'stop' ? f.api.stopDsh('tab') : f.api.setDshRoute('tab', { provider: 'p', model: 'second' }); await flush();
  release(); f.fire(300); await flush(); gate.resolve(); await change; await flush();
  assert.equal(f.connection(), undefined); assert.equal(live.size, 0);
});
await test('DeepSeek: close while the previous runtime is stopping prevents replacement startup', async () => {
  const closing = deferred(); let closes = 0;
  const f = await fixture('dsh', async command => {
    if (command === 'dsh_session_start') return resultFor('dsh');
    if (command === 'dsh_session_close' && ++closes === 1) await closing.promise;
    return {};
  });
  const release = f.retain(); await flush();
  const change = f.api.setDshRoute('tab', { provider: 'p', model: 'second' }); await flush();
  release(); f.fire(300); await flush(); closing.resolve(); await change; await flush();
  assert.equal(f.calls.filter(c => c.command === 'dsh_session_start').length, 1);
  assert.equal(f.connection(), undefined);
});
await test('DeepSeek: close during history releases the runtime immediately', async () => {
  const history = deferred(), live = new Set();
  const f = await fixture('dsh', async (command, args) => {
    if (command === 'dsh_session_start') { live.add(args.generation); return resultFor('dsh'); }
    if (command === 'dsh_session_close') live.delete(args.generation);
    if (command === 'dsh_session_history') return history.promise;
    return {};
  });
  const release = f.retain('native'); await flush(); release(); f.fire(300); await flush();
  assert.equal(live.size, 0);
  history.resolve([]); await flush();
  assert.equal(f.connection(), undefined);
  assert.equal(f.calls.filter(c => c.command === 'dsh_session_start').length, 1);
});
await test('DeepSeek: exit during history cannot restore readiness', async () => {
  const history = deferred(); let generation;
  const f = await fixture('dsh', async (command, args) => {
    if (command === 'dsh_session_start') { generation = args.generation; return resultFor('dsh'); }
    if (command === 'dsh_session_history') return history.promise;
    return {};
  });
  const release = f.retain('native'); await flush();
  f.emit(generation, { method: 'coffee/exit', params: { code: 1, detail: 'runtime exited during history' } });
  history.resolve([]); await flush();
  assert.equal(f.connection().ready, false); assert.match(f.connection().state.error, /runtime exited/);
  release(); f.fire(300); await flush();
});
await test('DeepSeek: live messages and approvals survive delayed history', async () => {
  const history = deferred(); let generation;
  const f = await fixture('dsh', async (command, args) => {
    if (command === 'dsh_session_start') { generation = args.generation; return resultFor('dsh'); }
    if (command === 'dsh_session_history') return history.promise;
    return {};
  });
  const release = f.retain('native'); await flush();
  f.emit(generation, { method: 'session.event', params: { sessionId: 'native', event: { type: 'assistant/message', data: { turn: 2, message: { id: 'live', content: [{ type: 'text', text: 'Live answer' }] } } } } });
  f.emit(generation, { id: 'approval', method: 'approval/request', params: { sessionId: 'native' } });
  history.resolve([
    { type: 'user/message', seq: 1, data: { id: 'old', source: { kind: 'user' }, content: [{ type: 'text', text: 'Old prompt' }] } },
    { type: 'assistant/message', data: { turn: 2, message: { id: 'live', content: [{ type: 'text', text: 'Older answer snapshot' }] } } },
  ]); await flush();
  assert.deepEqual(Array.from(f.connection().state.messages, m => m.content), ['Old prompt', 'Live answer']);
  assert.equal(f.connection().state.requests[0].id, 'approval'); assert.equal(f.replies.length, 0);
  release(); f.fire(300); await flush();
});
for (const reason of ['completed', 'failed', 'interrupted']) await test(`DeepSeek: ${reason} reply classification`, async () => {
  let generation;
  const f = await fixture('dsh', async (command, args) => { if (command === 'dsh_session_start') { generation = args.generation; return resultFor('dsh'); } return {}; });
  const release = f.retain(); await flush();
  const event = (type, data) => f.emit(generation, { method: 'session.event', params: { sessionId: 'native', event: { type, data } } });
  event('turn/start', { turn: 1 }); event('turn/end', { turn: 1, reason: { kind: reason } });
  f.emit(generation, { method: 'session.status', params: { sessionId: 'native', status: 'idle' } });
  event('turn/end', { turn: 1, reason: { kind: reason } });
  assert.equal(f.replies.length, reason === 'completed' ? 1 : 0);
  release(); f.fire(300); await flush();
});
await test('DeepSeek: queued model changes cannot restart a replacement tab', async () => {
  let starts = 0; const oldSwitch = deferred();
  const f = await fixture('dsh', async command => {
    if (command === 'dsh_session_start') { if (++starts === 2) await oldSwitch.promise; return resultFor('dsh'); }
    return {};
  });
  const release = f.retain(); await flush();
  const first = f.api.setDshRoute('tab', { provider: 'p', model: 'second' }); await flush();
  const queued = f.api.setDshRoute('tab', { provider: 'p', model: 'third' });
  release(); f.fire(300); await flush();
  const replacement = f.retain(); await flush();
  const generation = f.connection().generation;
  oldSwitch.resolve(); await Promise.all([first, queued]); await flush();
  assert.equal(starts, 3, 'the old queued switch never reaches the replacement client');
  assert.equal(f.connection().generation, generation);
  replacement(); f.fire(300); await flush();
});
await test('Claude: an old preview cannot populate a retried generation', async () => {
  const oldPreview = deferred(), retry = deferred(); let starts = 0, previews = 0;
  const f = await fixture('claude', async command => {
    if (command === 'claude_session_preview') return ++previews === 1 ? oldPreview.promise : { data: '', cursor: 0 };
    if (command === 'claude_session_start') { if (++starts === 1) throw new Error('temporary startup failure'); return retry.promise; }
    return {};
  });
  const release = f.retain('native'); await flush(); f.fire(1000); await flush();
  oldPreview.resolve({ data: JSON.stringify({ type: 'user', uuid: 'obsolete', message: { role: 'user', content: 'Stale history' } }), cursor: 7 }); await flush();
  assert.equal(f.connection().state.messages.length, 0, 'preview belongs to the generation that requested it');
  retry.resolve(resultFor('claude')); await flush();
  assert.equal(f.connection().ready, true);
  release(); f.fire(300); await flush();
});
for (const tool of ['opencode', 'pi']) {
  await test(`${tool}: a late model reply never sends follow-up requests to a replacement tab`, async () => {
    const model = deferred();
    const f = await fixture(tool, async (command, args) => {
      if (command.endsWith('_start')) return resultFor(tool);
      if (args.op === 'model' || args.command?.type === 'set_model') return model.promise;
      return {};
    });
    const release = f.retain(); await flush();
    const change = tool === 'pi' ? f.api.setPiModel('tab', { provider: 'p', id: 'new-model' }) : f.api.configureOpenCode('tab', { model: { providerID: 'p', id: 'new-model' }, agent: 'new-agent' });
    await flush(); release(); f.fire(300); await flush();
    const replacement = f.retain(); await flush();
    model.resolve({ provider: 'p', id: 'new-model' }); await change; await flush();
    assert.equal(f.calls.filter(call => call.op === 'agent' || call.request?.type === 'get_state').length, 0);
    replacement(); f.fire(300); await flush();
  });
  await test(`${tool}: final startup failure closes its runtime`, async () => {
    const f = await fixture(tool, async command => { if (command.endsWith('_start')) throw new Error('not installed'); return {}; });
    const release = f.retain(); await flush();
    assert.equal(f.connection().ready, false);
    assert.equal(f.calls.filter(call => call.command.endsWith('_close')).length, 1);
    release(); f.fire(300); await flush();
  });
  await test(`${tool}: an exit before the startup reply never restores readiness`, async () => {
    const start = deferred(); let generation;
    const f = await fixture(tool, async (command, args) => { if (command.endsWith('_start')) { generation = args.generation; return start.promise; } return {}; });
    const release = f.retain(); await flush();
    f.emit(generation, tool === 'pi' ? { type: 'coffee_exit', detail: 'runtime exited during startup' } : { type: 'coffee.exit', data: { detail: 'runtime exited during startup' } });
    start.resolve(resultFor(tool)); await flush();
    assert.equal(f.connection().ready, false);
    assert.ok(f.calls.some(call => call.command.endsWith('_close') && call.generation === generation));
    release(); f.fire(300); await flush(); f.fire(1000); await flush();
    assert.equal(f.connection(), undefined);
  });
}
await test('OpenCode: startup snapshots preserve live requests and resolved approvals', async () => {
  const start = deferred(); let generation;
  const f = await fixture('opencode', async (command, args) => { if (command.endsWith('_start')) { generation = args.generation; return start.promise; } return {}; });
  const release = f.retain('native'); await flush();
  f.emit(generation, { type: 'form.created', data: { form: { id: 'live-question', sessionID: 'native' } } });
  f.emit(generation, { type: 'permission.replied', data: { requestID: 'answered' } });
  start.resolve({ ...resultFor('opencode'), permissions: [{ id: 'answered', sessionID: 'native' }] }); await flush();
  assert.deepEqual(Array.from(f.connection().state.forms, form => form.id), ['live-question']);
  assert.equal(f.connection().state.permissions.length, 0, 'a resolved request is not resurrected from startup');
  assert.equal(f.questions.length, 1);
  release(); f.fire(300); await flush();
});
await test('Pi: startup history preserves live messages and approval requests', async () => {
  const start = deferred(); let generation;
  const f = await fixture('pi', async (command, args) => { if (command.endsWith('_start')) { generation = args.generation; return start.promise; } return {}; });
  const release = f.retain('native'); await flush();
  f.emit(generation, { type: 'agent_start' });
  f.emit(generation, { type: 'message_end', message: { role: 'assistant', timestamp: 20, content: [{ type: 'text', text: 'Live answer' }] } });
  f.emit(generation, { type: 'extension_ui_request', id: 'approval', method: 'confirm' });
  start.resolve({ ...resultFor('pi'), messages: [{ role: 'user', timestamp: 10, content: 'Old prompt' }, { role: 'assistant', timestamp: 20, content: [{ type: 'text', text: 'Older answer' }] }] });
  await flush();
  assert.deepEqual(Array.from(f.connection().state.messages, message => message.content), ['Old prompt', 'Live answer']);
  assert.equal(f.connection().state.busy, true);
  assert.equal(f.connection().state.requests[0].id, 'approval');
  assert.equal(f.replies.length, 0);
  release(); f.fire(300); await flush();
});
for (const outcome of ['success', 'failed', 'aborted']) await test(`Pi: ${outcome} completion notification is live and unique`, async () => {
  let generation;
  const f = await fixture('pi', async (command, args) => { if (command.endsWith('_start')) { generation = args.generation; return resultFor('pi'); } return {}; });
  const release = f.retain(); await flush();
  const settled = { type: 'agent_settled', aborted: outcome === 'aborted' };
  f.emit(generation, settled);
  assert.equal(f.replies.length, 0, 'idle or replayed completion creates no unread reply');
  f.emit(generation, { type: 'agent_start' });
  if (outcome === 'failed') f.emit(generation, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Provider failed', timestamp: 20, content: [] } });
  f.emit(generation, settled); f.emit(generation, settled);
  assert.equal(f.replies.length, outcome === 'success' ? 1 : 0);
  release(); f.fire(300); await flush();
});
console.log(`${passed} native session lifecycle cases passed; ${failed} failed`);
if (failed) process.exitCode = 1;
