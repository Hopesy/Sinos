import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `export * from './src/lib/session-replies';export * from './src/lib/use-session-reply-visibility'; export * as agent from './src/lib/agent-client'; export * as claude from './src/lib/claude-session'; export * as codex from './src/lib/codex-session';` }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /(?:^react$|\/tauri$|^@tauri-apps\/api\/event$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react'
      ? 'export const useEffect=globalThis.mountEffect;export const useSyncExternalStore=(_,snapshot)=>snapshot();'
      : args.path.includes('/event') ? 'export async function listen(name,fn){globalThis.nativeListeners.set(name,fn);return()=>{}}'
        : 'export const invoke=globalThis.nativeInvoke;' }));
  } }],
});
function fixture(storage = new Map(), blocked = false) {
  const nativeListeners = new Map(), generations = new Map(), documentListeners = new Map();
  let focused = true, cleanup;
  const document = { hidden: false, hasFocus: () => focused, addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name) };
  const module = { exports: {} };
  const nativeInvoke = async (command, args) => {
    if (command === 'agent_list_conversations') return [];
    if (command === 'agent_get_conversation') return { id: args.conversationId, route: 'desktop', messages: [], hasOlder: false };
    if (command.endsWith('_session_start')) {
      generations.set(args.id, args.generation);
      if (command.startsWith('claude')) return { sessionId: 'shared-token', initialization: {}, history: { data: '{"type":"result","subtype":"success"}', cursor: 0 } };
      return { thread: { id: 'shared-token', turns: [{ id: 'old', status: 'completed', items: [] }] }, models: [] };
    }
    assert.ok(['claude_session_control', 'claude_session_close', 'codex_session_close'].includes(command), 'no tool configuration or hook writes: ' + command);
    return {};
  };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, nativeListeners, nativeInvoke, document,
    window: { addEventListener() {}, removeEventListener() {} }, crypto: { randomUUID }, setTimeout, clearTimeout,
    mountEffect: effect => { cleanup?.(); cleanup = effect(); },
    localStorage: { getItem: key => { if (blocked) throw Error('blocked'); return storage.get(key) ?? null; }, setItem: (key, value) => { if (blocked) throw Error('blocked'); storage.set(key, value); } },
  });
  const api = module.exports;
  const terminals = [{ id: 'a', tool: 'claude', resumeToken: 'shared-token' }, { id: 'b', tool: 'codex', resumeToken: 'shared-token' }];
  let state = { terminals, activeTerminalId: null, sessionSplit: null };
  const view = patch => { state = { ...state, ...patch }; api.useSessionReplyVisibility(state); };
  const focus = value => { focused = value; documentListeners.get('visibilitychange')?.(); };
  const claude = (event, generation = generations.get('a')) => nativeListeners.get('claude-session-event')({ payload: { id: 'a', generation, event } });
  const codex = (method, params = {}, generation = generations.get('b')) => nativeListeners.get('codex-session-event')({ payload: { id: 'b', generation, event: { method, params: { threadId: 'shared-token', ...params } } } });
  return { api, storage, view, focus, claude, codex, dispose: () => cleanup?.() };
}
async function connect(h) {
  const releases = [h.api.claude.retainClaudeSession('a', 'D:/Project'), h.api.codex.retainCodexSession('b', 'D:/Project')];
  for (let i = 0; i < 100 && (!h.api.claude.getClaudeConnection('a')?.ready || !h.api.codex.getCodexConnection('b')?.ready); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.api.claude.getClaudeConnection('a')?.ready, true);
  assert.equal(h.api.codex.getCodexConnection('b')?.ready, true);
  return () => releases.forEach(release => release());
}
const h = fixture(), release = await connect(h);
const unread = () => [...h.api.getUnreadSessionReplies()].sort();
const startClaude = () => h.claude({ type: 'stream_event', event: { type: 'message_start', message: { id: randomUUID() } } });
const finishClaude = () => h.claude({ type: 'result', subtype: 'success' });
const startCodex = () => h.codex('turn/started', { turn: { id: 'live' } });
const finishCodex = status => h.codex('turn/completed', { turn: { id: 'live', status } });
try {
  h.view({});
  assert.deepEqual(unread(), [], 'restoring history creates no unread replies');
  finishClaude(); finishCodex('completed');
  assert.deepEqual(unread(), [], 'an unsolicited idle result is not new work');
  startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token'], 'only the completed tool/session becomes unread');
  startCodex(); finishCodex('interrupted'); startCodex(); finishCodex('failed');
  assert.deepEqual(unread(), ['claude:shared-token'], 'interruptions and failures do not invent successful replies');
  startCodex(); finishCodex('completed');
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token'], 'cross-tool tokens stay independent');
  assert.equal(h.api.getUnreadTaskCount(), 2, 'the taskbar counts completed turns');
  startClaude(); finishClaude(); finishClaude();
  assert.equal(h.api.getUnreadTaskCount(), 3, 'another completed turn adds one; replay adds none');
  const restarted = fixture(h.storage);
  assert.deepEqual([...restarted.api.getUnreadSessionReplies()].sort(), unread(), 'unread markers survive restart');
  assert.equal(restarted.api.getUnreadTaskCount(), 3, 'completion counts survive restart');
  h.view({ activeTerminalId: 'a' });
  assert.deepEqual(unread(), ['codex:shared-token']);
  assert.equal(h.api.getUnreadTaskCount(), 1, 'reading one conversation clears all of its completed turns');
  finishClaude(); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['codex:shared-token'], 'duplicates and a visible foreground reply do not restore unread');
  h.focus(false); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token']);
  h.focus(true);
  assert.deepEqual(unread(), ['codex:shared-token'], 'returning to the visible conversation clears its marker');
  h.view({ usageOpen: true }); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token'], 'statistics does not acknowledge a covered conversation');
  h.view({ usageOpen: false, toolSettingsOpen: true }); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token'], 'tool settings does not acknowledge a covered conversation');
  h.view({ toolSettingsOpen: false, sessionSplit: { type: 'branch', first: { type: 'leaf', sessionId: 'a' }, second: { type: 'leaf', sessionId: 'b' } } });
  assert.deepEqual(unread(), [], 'both visible split panes are acknowledged');
  h.view({ editorTabActive: true }); startClaude(); finishClaude(); startCodex(); finishCodex('completed');
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token'], 'an editor or image tab covering the split retains both unread replies');
  h.focus(false); h.focus(true);
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token'], 'returning focus to the editor does not read hidden replies');
  h.view({ editorTabActive: false });
  assert.deepEqual(unread(), [], 'returning to the visible split acknowledges both replies');
  h.view({ sessionSplit: null, settingsOpen: true }); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token']);
  h.view({ settingsOpen: false });
  assert.deepEqual(unread(), []);
  h.view({ automationsOpen: true }); startClaude(); finishClaude();
  h.focus(false); h.focus(true);
  assert.deepEqual(unread(), ['claude:shared-token'], 'automations covering a session retain its unread reply');
  h.view({ automationsOpen: false });
  assert.deepEqual(unread(), []);
  h.view({ activeTerminalId: null }); startClaude();
  h.claude({ type: 'result', subtype: 'error_during_execution', is_error: true });
  startClaude(); await h.api.claude.controlClaude('a', { subtype: 'interrupt' }); finishClaude();
  assert.deepEqual(unread(), [], 'native failures and locally requested stops remain distinct from completion');
  startClaude(); h.claude({ type: 'result', subtype: 'success' }, 'obsolete-generation');
  assert.deepEqual(unread(), [], 'late events from another generation are ignored');
  const unavailable = fixture(new Map([['coffee:unread-session-replies', '{broken']]), true);
  unavailable.api.recordSessionReply('one', 'codex', 'new');
  assert.deepEqual([...unavailable.api.getUnreadSessionReplies()], ['codex:new']);
  assert.equal(unavailable.api.getUnreadTaskCount(), 1);
  unavailable.api.clearUnreadTasks(); assert.equal(unavailable.api.getUnreadTaskCount(), 0);

  const transient = fixture();
  transient.api.recordSessionReply('temp', 'codex', '@temp');
  transient.api.recordSessionReply('temp', 'codex', '@temp');
  assert.equal(fixture(transient.storage).api.getUnreadTaskCount(), 0, 'ephemeral terminal IDs never survive restart');
  transient.api.updateSessionReplyReaders([{ id: 'temp', tool: 'codex', resumeToken: 'real-token' }], []);
  assert.equal(transient.api.getUnreadTaskCount(), 2, 'receiving the real conversation ID preserves its count');
  assert.deepEqual([...transient.api.getUnreadSessionReplies()], ['codex:real-token']);
  transient.api.recordSessionReply('closed', 'claude', '@closed');
  transient.api.updateSessionReplyReaders([], []);
  assert.equal(transient.api.getUnreadTaskCount(), 2, 'closing an ephemeral terminal removes its inaccessible count');
  transient.api.updateSessionReplyReaders([{ id: 'reopened', tool: 'codex', resumeToken: 'real-token' }], ['reopened']);
  assert.equal(transient.api.getUnreadTaskCount(), 0, 'reopening the saved conversation acknowledges its completed turns');

  const agent = fixture(), event = (kind, runId = 'one') => agent.api.agent.receiveAgentEvent({ conversationId: 'agent-test', runId, kind });
  event('done'); assert.equal(agent.api.getUnreadTaskCount(), 0, 'unsolicited agent results do not count');
  event('started'); event('done'); event('done');
  assert.equal(agent.api.getUnreadTaskCount(), 1, 'one successful agent run counts once');
  for (const kind of ['error', 'cancelled']) { event('started', kind); event(kind, kind); event('done', kind); }
  assert.equal(agent.api.getUnreadTaskCount(), 1, 'failed and cancelled agent runs stay out of completion counts');
  event('started', 'new'); event('done', 'old'); event('done', 'new');
  assert.equal(agent.api.getUnreadTaskCount(), 2, 'stale agent results do not consume the active run');
  await agent.api.agent.openAgentConversation('agent-test');
  agent.view({ agentPageActive: 'agent', settingsOpen: true });
  assert.equal(agent.api.getUnreadTaskCount(), 2, 'settings covering Agent keep its count');
  agent.view({ settingsOpen: false, automationsOpen: true });
  assert.equal(agent.api.getUnreadTaskCount(), 2, 'automations covering Agent keep its unread count');
  agent.view({ automationsOpen: false }); assert.equal(agent.api.getUnreadTaskCount(), 0);
  event('started', 'foreground'); event('done', 'foreground'); assert.equal(agent.api.getUnreadTaskCount(), 0);
  agent.dispose(); transient.dispose();
  unavailable.dispose(); restarted.dispose();
  console.log('OK: real desktop completion events, history/replay/stop/error isolation, per-tool identity, visible panes, focus, overlays, persistent unread and unavailable storage; no tool-file writes');
} finally { h.dispose(); release(); }
