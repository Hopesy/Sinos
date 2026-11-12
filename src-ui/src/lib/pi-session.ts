import { useSyncExternalStore } from 'react';
import { directoryFailure } from './session-directory';
import { recordSessionReply, recordSessionQuestion } from './session-replies';
import { markPromptSubmitted } from './notify-prompts';
import { invoke } from '../tauri';
import { arr, emptyPiState, obj, piModel, piStats, reducePiEvent, restorePiMessages, str, type Json, type PiDialog, type PiModel, type PiState } from './pi-protocol';

interface Client { state: PiState; generation: string; listeners: Set<() => void>; owners: number; cwd: string | null; dialogTimers: Map<PiDialog, ReturnType<typeof setTimeout>>; starting?: Promise<void>; connecting?: boolean; exited?: boolean; turnFailed?: boolean; closeTimer?: ReturnType<typeof setTimeout>; publishTimer?: ReturnType<typeof setTimeout> }
const clients = new Map<string, Client>();
const EMPTY = emptyPiState();
const current = (id: string, c: Client, generation = c.generation) => clients.get(id) === c && c.generation === generation;
let listening: Promise<unknown> | undefined;

function client(id: string): Client {
  let c = clients.get(id);
  if (!c) { c = { state: emptyPiState(), generation: crypto.randomUUID(), listeners: new Set(), owners: 0, cwd: null, dialogTimers: new Map() }; clients.set(id, c); }
  return c;
}
function publish(c: Client, immediate = false) {
  if (immediate) { clearTimeout(c.publishTimer); c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }
  else if (!c.publishTimer) c.publishTimer = setTimeout(() => { c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }, 40);
}
// Pi uses Node's setTimeout: zero means no timeout, while negative, fractional below 1ms,
// and overflowing values fire after 1ms. Keep timers attached to dialog objects, not IDs:
// Pi can reuse an ID after a response, abort, or a new client generation.
function syncDialogTimers(id: string, c: Client) {
  for (const [dialog, timer] of c.dialogTimers) {
    if (!c.state.requests.includes(dialog)) { clearTimeout(timer); c.dialogTimers.delete(dialog); }
  }
  const generation = c.generation;
  for (const dialog of c.state.requests) {
    const timeout = dialog.timeout;
    if (timeout === undefined || timeout === 0 || c.dialogTimers.has(dialog)) continue;
    const delay = timeout < 1 || timeout > 2147483647 ? 1 : Math.floor(timeout);
    c.dialogTimers.set(dialog, setTimeout(() => {
      c.dialogTimers.delete(dialog);
      if (!current(id, c, generation) || !c.state.requests.includes(dialog)) return;
      c.state = { ...c.state, requests: c.state.requests.filter(r => r !== dialog) };
      publish(c, true);
    }, delay));
  }
}
function clearDialogs(id: string, c: Client) {
  c.state = { ...c.state, requests: [] };
  syncDialogTimers(id, c);
}
async function request(id: string, command: Json): Promise<Json> {
  const c = clients.get(id);
  if (!c) throw new Error('Pi session is not running');
  const generation = c.generation;
  const result = await invoke<Json>('pi_session_request', { id, generation, command });
  if (!current(id, c, generation)) throw new Error('Pi session closed');
  return result;
}
/** Context and token totals come from Pi's own statistics after each run. */
async function refreshStats(id: string, c: Client) {
  const generation = c.generation;
  try { const data = await invoke<Json>('pi_session_request', { id, generation, command: { type: 'get_session_stats' } }); if (!current(id, c, generation) || c.exited) return; c.state = { ...c.state, stats: piStats(obj(data), c.state.stats) }; publish(c, true); }
  catch { /* Statistics are informational. */ }
}
function listen() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string; generation: string; event: Json }>('pi-session-event', ({ payload }) => {
    const c = clients.get(payload.id); if (!c || c.generation !== payload.generation) return;
    const type = str(payload.event.type), wasBusy = c.state.busy;
    const previousRequests = new Set(c.state.requests.map(request => request.id));
    if (type === 'coffee_exit') c.exited = true;
    if (type === 'agent_start') c.turnFailed = false;
    if (type === 'message_end' && obj(payload.event.message).role === 'assistant') c.turnFailed = obj(payload.event.message).stopReason === 'error';
    if (type === 'auto_retry_end') c.turnFailed = payload.event.success === false;
    c.state = reducePiEvent(c.state, payload.event);
    syncDialogTimers(payload.id, c);
    if (c.owners > 0 && c.state.requests.some(request => !previousRequests.has(request.id))) recordSessionQuestion(payload.id, 'pi');
    if (type === 'agent_settled') {
      if (wasBusy && c.state.ready && !c.connecting && !c.turnFailed && !c.state.interrupted) recordSessionReply(payload.id, 'pi', c.state.sessionId);
      void refreshStats(payload.id, c);
    }
    if (type === 'compaction_end') void refreshStats(payload.id, c);
    publish(c, !['message_update', 'tool_execution_update'].includes(type));
  })).catch(error => { listening = undefined; throw error; });
}
export function usePiSession(id: string): PiState;
export function usePiSession<T>(id: string, select: (state: PiState) => T): T;
export function usePiSession(id: string, select: (state: PiState) => unknown = state => state) {
  return useSyncExternalStore(fn => { const c = client(id); c.listeners.add(fn); return () => { c.listeners.delete(fn); }; }, () => select(clients.get(id)?.state ?? EMPTY), () => select(EMPTY));
}
export function getPiConnection(id: string) {
  const c = clients.get(id);
  return c && c.owners > 0 ? { generation: c.generation, state: c.state, ready: c.state.ready && !c.connecting, inputBusy: c.state.busy } : undefined;
}

async function connect(id: string, c: Client, resumeToken: string | undefined) {
  const generation = c.generation;
  await listen();
  if (!current(id, c, generation)) return;
  const result = await invoke<Json>('pi_session_start', { id, generation, cwd: c.cwd, resumeToken: resumeToken ?? null });
  if (!current(id, c, generation)) { await invoke('pi_session_close', { id, generation }).catch(() => {}); return; }
  if (c.exited) throw new Error(c.state.error || 'Pi process exited');
  const state = obj(result.state);
  const models = arr(result.models).map(piModel).filter((m): m is PiModel => !!m);
  let next: PiState = { ...c.state, ready: true, error: undefined, sessionId: str(result.sessionId), title: str(state.sessionName) || c.state.title, model: piModel(state.model), thinkingLevel: str(state.thinkingLevel) || 'off', models, busy: state.isStreaming === true || c.state.busy };
  if (resumeToken) {
    const history = restorePiMessages(arr(result.messages), next).messages;
    const liveIds = new Set(c.state.messages.map(message => message.id));
    next = { ...next, messages: [...history.filter(message => !liveIds.has(message.id)), ...c.state.messages] };
  }
  c.state = next; publish(c, true);
  if (resumeToken) void refreshStats(id, c);
}

export function retainPiSession(id: string, cwd: string | null, resumeToken?: string): () => void {
  const c = client(id); clearTimeout(c.closeTimer); c.owners++; c.cwd = cwd;
  c.starting ??= (async () => {
    c.connecting = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = c.generation;
      try { await connect(id, c, resumeToken); return; }
      catch (error) {
        if (!current(id, c, generation)) return;
        if (directoryFailure(error) || attempt === 1 || /not installed/i.test(String(error))) {
          if (!directoryFailure(error)) void invoke('pi_session_close', { id, generation }).catch(() => {});
          c.state = { ...c.state, ready: false, error: String(error) }; publish(c, true); return;
        }
        clearDialogs(id, c);
        c.generation = crypto.randomUUID();
        await invoke('pi_session_close', { id, generation }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!c.owners || !current(id, c)) return;
        c.exited = false; c.turnFailed = false;
        c.state = { ...c.state, ready: false, error: undefined };
      }
    }
  })().finally(() => { c.connecting = false; });
  return () => {
    if (--c.owners) return;
    c.closeTimer = setTimeout(() => {
      if (c.owners || !current(id, c)) return;
      clearDialogs(id, c);
      clients.delete(id);
      void invoke('pi_session_close', { id, generation: c.generation }).catch(() => {});
      clearTimeout(c.publishTimer);
    }, 300);
  };
}

/** A message typed during a run steers it, as in Pi's own editor. */
export async function sendPiMessage(id: string, prompt: string): Promise<boolean> {
  const c = clients.get(id); const message = prompt.trim();
  if (!c?.state.ready || !message) return false;
  if (!c.state.model) { c.state = { ...c.state, error: 'no-model' }; publish(c, true); return false; }
  const steer = c.state.busy;
  // Pi's status is not native to the chime, which waits for a prompt the user sent before announcing a finished run.
  markPromptSubmitted(id);
  if (!steer) { c.state = { ...c.state, busy: true, startedAt: Date.now(), endedAt: undefined, interrupted: false, error: undefined }; publish(c, true); }
  try {
    await request(id, steer ? { type: 'steer', message } : { type: 'prompt', message });
    return true;
  } catch (error) {
    c.state = { ...c.state, busy: steer, error: String(error) }; publish(c, true);
    return false;
  }
}
export async function abortPi(id: string) {
  const c = clients.get(id); if (!c?.state.busy) return;
  clearDialogs(id, c); publish(c, true);
  await request(id, { type: 'abort' }).catch(() => {});
}
export async function setPiModel(id: string, model: PiModel) {
  const c = clients.get(id); if (!c) return;
  try {
    const data = await request(id, { type: 'set_model', provider: model.provider, modelId: model.id });
    c.state = { ...c.state, model: piModel(data) ?? model, error: undefined };
    // A model without reasoning turns thinking off; read back what Pi applied.
    const state = await request(id, { type: 'get_state' }).catch(() => undefined);
    if (state) c.state = { ...c.state, thinkingLevel: str(state.thinkingLevel) || c.state.thinkingLevel };
    publish(c, true); void refreshStats(id, c);
  } catch (error) { c.state = { ...c.state, error: String(error) }; publish(c, true); }
}
export async function getPiThinkingLevels(id: string): Promise<string[]> {
  const data = await request(id, { type: 'get_available_thinking_levels' }).catch(() => ({} as Json));
  return arr(data.levels).map(str).filter(Boolean);
}
export async function setPiThinkingLevel(id: string, level: string) {
  const c = clients.get(id); if (!c) return;
  try { await request(id, { type: 'set_thinking_level', level }); c.state = { ...c.state, thinkingLevel: level }; publish(c, true); }
  catch (error) { c.state = { ...c.state, error: String(error) }; publish(c, true); }
}
export async function compactPi(id: string) {
  const c = clients.get(id); if (!c?.state.ready || c.state.busy) return;
  try { await request(id, { type: 'compact' }); } catch (error) { c.state = { ...c.state, error: String(error) }; publish(c, true); }
}
export async function respondPi(id: string, requestId: string, response: Json): Promise<void> {
  const c = clients.get(id); if (!c) return;
  const generation = c.generation, dialog = c.state.requests.find(r => r.id === requestId);
  if (!dialog) throw new Error('This Pi request has ended');
  try { await invoke('pi_session_respond', { id, generation, requestId, response }); }
  finally {
    if (current(id, c, generation) && c.state.requests.includes(dialog)) {
      c.state = { ...c.state, requests: c.state.requests.filter(r => r !== dialog) };
      syncDialogTimers(id, c); publish(c, true);
    }
  }
}
