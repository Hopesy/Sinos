import { useSyncExternalStore } from 'react';
import { directoryFailure } from './session-directory';
import { recordSessionReply, recordSessionQuestion } from './session-replies';
import { invoke } from '../tauri';
import { arr, obj, str, emptyDshState, reduceDshNotification, restoreDshLog, type DshModel, type DshRoute, type DshState, type Json } from './dsh-protocol';

interface Client { state: DshState; generation: string; listeners: Set<() => void>; owners: number; cwd: string | null; starting?: Promise<void>; switching?: Promise<void>; preset?: string; connecting?: boolean; exited?: boolean; replyTurn?: number; closeTimer?: ReturnType<typeof setTimeout>; publishTimer?: ReturnType<typeof setTimeout> }
const clients = new Map<string, Client>();
const EMPTY = emptyDshState();
const current = (id: string, c: Client, generation = c.generation) => clients.get(id) === c && c.generation === generation;
function requireCurrent(id: string, c: Client, generation: string) {
  if (!current(id, c, generation)) throw new Error('DeepSeek Harness session closed');
  if (c.exited) throw new Error(c.state.error || 'DeepSeek Harness process exited');
}
let listening: Promise<unknown> | undefined;

/** Native commands the SDK routes through `session/query` (official names and Chinese aliases). */
export const DSH_COMMANDS = ['compact', 'permission', 'plan', 'goal'] as const;
const COMMAND = /^\/(compact|permission|plan|goal|压缩|权限|计划|目标)(\s|$)/;

function client(id: string): Client {
  let c = clients.get(id);
  if (!c) { c = { state: emptyDshState(), generation: crypto.randomUUID(), listeners: new Set(), owners: 0, cwd: null }; clients.set(id, c); }
  return c;
}
function publish(c: Client, immediate = false) {
  if (immediate) { clearTimeout(c.publishTimer); c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }
  else if (!c.publishTimer) c.publishTimer = setTimeout(() => { c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }, 40);
}
function listen() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string; generation: string; event: Json }>('dsh-session-event', ({ payload }) => {
    const c = clients.get(payload.id); if (!c || c.generation !== payload.generation) return;
    const previousRequests = new Set(c.state.requests.map(request => JSON.stringify(request.id)));
    c.state = reduceDshNotification(c.state, payload.event);
    if (c.owners > 0 && c.state.requests.some(request => !previousRequests.has(JSON.stringify(request.id)))) recordSessionQuestion(payload.id, 'dsh');
    if (payload.event.method === 'coffee/exit') { c.exited = true; c.replyTurn = undefined; }
    const params = obj(payload.event.params), event = obj(params.event), data = obj(event.data);
    if (c.state.ready && !c.connecting && !c.state.restarting && payload.event.method === 'session.event' && params.sessionId === c.state.sessionId) {
      if (event.type === 'turn/start' && typeof data.turn === 'number') c.replyTurn = data.turn;
      if (event.type === 'turn/end' && c.replyTurn !== undefined && c.replyTurn === data.turn) {
        c.replyTurn = undefined;
        if (obj(data.reason).kind === 'completed') recordSessionReply(payload.id, 'dsh', c.state.sessionId);
      }
    }
    publish(c, payload.event.id !== undefined || ['session.status', 'coffee/exit', 'user-question.cancelled'].includes(str(payload.event.method)));
  })).catch(error => { listening = undefined; throw error; });
}
export function useDshSession(id: string): DshState;
export function useDshSession<T>(id: string, select: (state: DshState) => T): T;
export function useDshSession(id: string, select: (state: DshState) => unknown = state => state) {
  return useSyncExternalStore(fn => { const c = client(id); c.listeners.add(fn); return () => { c.listeners.delete(fn); }; }, () => select(clients.get(id)?.state ?? EMPTY), () => select(EMPTY));
}
export function getDshConnection(id: string) {
  const c = clients.get(id);
  return c && c.owners > 0 ? { generation: c.generation, state: c.state, ready: c.state.ready && !c.connecting && !c.state.restarting, inputBusy: c.state.busy } : undefined;
}

/** Starts (or restarts) the runtime; a known Session resumes and its persisted log restores the transcript. */
async function connect(id: string, c: Client, resumeToken: string | undefined, route: DshRoute | undefined, keepTranscript: boolean) {
  const generation = c.generation;
  c.connecting = true; c.exited = false; c.replyTurn = undefined;
  try {
    await listen();
    requireCurrent(id, c, generation);
    const result = await invoke<Json>('dsh_session_start', { id, generation, cwd: c.cwd, resumeToken: resumeToken ?? null, route: route ?? null, preset: resumeToken ? null : c.preset ?? null });
    if (!current(id, c, generation)) {
      await invoke('dsh_session_close', { id, generation }).catch(() => {});
    }
    requireCurrent(id, c, generation);
    const sessionId = str(result.sessionId), routeResult = obj(result.route);
    c.state = { ...c.state, sessionId, ready: false, error: undefined, routeError: str(result.routeError) || undefined, commands: result.commands !== false, models: arr(result.models).map(obj) as unknown as DshModel[],
      route: { provider: str(routeResult.provider), model: str(routeResult.model), effort: str(routeResult.effort) || null } };
    if (resumeToken && !keepTranscript) {
      const before = c.state;
      const rows = await invoke<unknown[]>('dsh_session_history', { sessionId }).catch(() => []);
      requireCurrent(id, c, generation);
      const history = restoreDshLog(rows, { ...before, messages: [] }), live = c.state;
      const messages = new Map(live.messages.map(message => [message.id, message]));
      const historicalIds = new Set(history.messages.map(message => message.id));
      // Merge history into the latest state, keeping live updates and approvals.
      c.state = { ...live,
        messages: [...history.messages.map(message => messages.get(message.id) ?? message), ...live.messages.filter(message => !historicalIds.has(message.id))],
        title: live.title === before.title ? history.title : live.title,
        preset: live.preset === before.preset ? history.preset : live.preset,
        policy: live.policy === before.policy ? history.policy : live.policy,
        contextWindow: live.contextWindow === before.contextWindow ? history.contextWindow : live.contextWindow,
      };
    }
    requireCurrent(id, c, generation);
    c.state = { ...c.state, ready: true, restarting: false, stopping: false }; publish(c, true);
  } finally { if (current(id, c, generation)) c.connecting = false; }
}

export function retainDshSession(id: string, cwd: string | null, resumeToken?: string): () => void {
  const c = client(id); clearTimeout(c.closeTimer); c.owners++; c.cwd = cwd;
  c.starting ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current(id, c)) return;
      try { await connect(id, c, resumeToken, undefined, false); return; }
      catch (error) {
        if (!current(id, c)) return;
        if (directoryFailure(error) || attempt === 1) {
          if (!directoryFailure(error)) void invoke('dsh_session_close', { id, generation: c.generation }).catch(() => {});
          c.state = { ...c.state, ready: false, error: String(error) }; publish(c, true); return;
        }
        const generation = c.generation; c.generation = crypto.randomUUID();
        await invoke('dsh_session_close', { id, generation }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!c.owners || !current(id, c)) return;
      }
    }
  })();
  return () => {
    if (--c.owners) return;
    c.closeTimer = setTimeout(() => {
      if (c.owners || !current(id, c)) return;
      clients.delete(id);
      void invoke('dsh_session_close', { id, generation: c.generation }).catch(() => {});
      clearTimeout(c.publishTimer);
    }, 300);
  };
}

/** The SDK has no cancel call: replace the runtime and resume the same Session, which repairs the interrupted turn. */
function restart(id: string, route?: DshRoute): Promise<void> {
  const c = clients.get(id); if (!c || c.state.restarting || !c.state.sessionId) return Promise.resolve();
  const previous = c.generation, sessionId = c.state.sessionId;
  c.generation = crypto.randomUUID();
  const generation = c.generation;
  c.replyTurn = undefined;
  c.state = { ...c.state, restarting: true, stopping: !route, busy: false, requests: [], startedAt: undefined }; publish(c, true);
  c.starting = (async () => {
    await invoke('dsh_session_close', { id, generation: previous }).catch(() => {});
    if (!current(id, c, generation)) return;
    // DeepSeek Harness creates a Session on its first prompt.
    const started = c.state.messages.length > 0;
    try { await connect(id, c, started ? sessionId : undefined, route ?? c.state.route, true); }
    catch (error) {
      await invoke('dsh_session_close', { id, generation }).catch(() => {});
      if (!current(id, c, generation)) return;
      // Retire the failed generation so its late exit preserves the start error.
      c.generation = crypto.randomUUID();
      c.state = { ...c.state, restarting: false, stopping: false, ready: false, error: String(error) }; publish(c, true);
    }
  })();
  return c.starting;
}
export const stopDsh = (id: string) => restart(id);
export function setDshRoute(id: string, route: DshRoute): Promise<void> {
  const c = clients.get(id);
  const done = restart(id, route);
  if (c) { c.switching = done; void done.finally(() => { if (c.switching === done) c.switching = undefined; }); }
  return done;
}

/** Applied live by Coffee's plugin, so a running turn carries on. The control shows only what the Session's
 * own events confirm; an unstarted tab has no Session yet, so its choice waits for the first prompt. */
export async function setDshPreset(id: string, preset: string) {
  const c = clients.get(id); if (!c) return;
  try { await invoke('dsh_session_set_preset', { id, generation: c.generation, preset }); }
  catch (error) { c.state = { ...c.state, error: String(error) }; publish(c, true); return; }
  c.preset = preset;
  if (!c.state.messages.length) { c.state = { ...c.state, preset }; publish(c, true); }
}

export async function sendDshMessage(id: string, prompt: string): Promise<boolean> {
  const c = clients.get(id); const text = prompt.trim();
  // A model or effort switch reloads in the background; a message sent meanwhile goes out once it is back.
  if (c?.switching) await c.switching;
  if (!c?.state.ready || c.state.restarting || !text) return false;
  // The configured model is missing: surface it now rather than answer from a model the user did not pick.
  if (c.state.routeError) { c.state = { ...c.state, error: c.state.routeError }; publish(c, true); return false; }
  const command = COMMAND.test(text);
  if (command && !c.state.commands) {
    // An older runtime would hand the command to the model as an ordinary prompt.
    c.state = { ...c.state, messages: [...c.state.messages, { id: `unsupported:${Date.now()}`, role: 'notice', content: 'commands-unsupported', turn: 0, timestamp: Date.now(), tone: 'info' }] }; publish(c, true);
    return true;
  }
  if (!command) { c.state = { ...c.state, busy: true, startedAt: c.state.startedAt ?? Date.now(), error: undefined }; publish(c, true); }
  try {
    await invoke('dsh_session_request', { id, generation: c.generation, method: command ? 'session/query' : 'session/prompt', params: { contentBlocks: [{ type: 'text', text }] } });
    return true;
  } catch (error) {
    c.state = { ...c.state, busy: false, error: String(error) }; publish(c, true);
    return false;
  }
}

export async function respondDsh(id: string, requestId: string | number, result: Json): Promise<void> {
  const c = clients.get(id); if (!c) return;
  await invoke('dsh_session_respond', { id, generation: c.generation, requestId, result });
  c.state = { ...c.state, requests: c.state.requests.filter(r => r.id !== requestId) }; publish(c, true);
}
