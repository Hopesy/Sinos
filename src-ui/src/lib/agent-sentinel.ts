import { invoke } from '../tauri';
import type { TerminalSession } from '../store/app-state';
import { getTerminalObserver } from './terminal-observer';
import { getTerminalInteraction } from './terminal-interaction';

export interface SentinelSession { sessionId: string; tool: string; title: string; cwd: string; status?: string }
interface Completion { superseded: boolean; epoch: number; session: SentinelSession; evidence?: { text: string; revision: number; capturedAt: number; complete: boolean } }
interface Task { generation: string; sequence: number; inputHint: string; additionalInputHint?: string; mixed: boolean; working: boolean; interrupted: boolean; timer?: ReturnType<typeof setTimeout>; completion?: Completion }
const supported = new Set(['claude', 'codex', 'kimicode', 'omp']);
const sessions = new Map<string, SentinelSession>();
const tasks = new Map<string, Task>();
const completions = new Map<Task, string>();
let enabled = false;
let sequence = 0;
let epoch = 0;
let language = 'en';

export function setSentinelEnabled(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  epoch++;
  tasks.forEach(task => clearTimeout(task.timer));
  completions.forEach((_, task) => clearTimeout(task.timer));
  tasks.clear();
  completions.clear();
}

export function updateSentinelSessions(terminals: TerminalSession[], locale: string): void {
  language = locale;
  updateSentinelTargets(terminals.flatMap(tab => {
    return tab.tool ? [{ sessionId: tab.id, tool: String(tab.tool), title: tab.toolTitle || String(tab.tool), cwd: tab.folderPath ?? '', status: tab.agentStatus }] : [];
  }));
}

export function updateSentinelTargets(targets: SentinelSession[]): void {
  sessions.clear();
  targets.filter(target => supported.has(target.tool)).forEach(target => sessions.set(target.sessionId, target));
  for (const [task, id] of completions) {
    if (!sessions.has(id) || getTerminalObserver(id)?.generation !== task.generation) cancelCompletion(task);
  }
  for (const [id, task] of tasks) {
    const session = sessions.get(id);
    if (!session || getTerminalObserver(id)?.generation !== task.generation) {
      clearTimeout(task.timer); tasks.delete(id); continue;
    }
    if (session.status === 'working') {
      if (task.working) {
        if (task.completion) task.mixed = true;
        clearTimeout(task.timer); task.timer = undefined; cancelCompletion(task);
      }
    } else if (session.status === 'wait_input') {
      cancelCompletion(task);
    } else if (task.working && session.status === 'idle' && !task.completion) {
      settle(id, task, task.interrupted ? 'interrupted' : 'ended');
    }
  }
}

/** Arm only a real submitted prompt; menus, empty Enter and pre-existing work do not count. */
export function markSentinelSubmission(id: string, text: string): number | undefined {
  const session = sessions.get(id);
  const observer = getTerminalObserver(id);
  if (!enabled || !text.trim() || !session || !observer || getTerminalInteraction(id) || session.status === 'wait_input') return;
  const previous = tasks.get(id);
  if (session.status === 'working') {
    // A working CLI may steer its current turn or queue another one. Input is not a verified turn boundary.
    if (previous?.working && previous.generation === observer.generation) {
      previous.mixed = true;
      previous.additionalInputHint = Array.from(`${previous.additionalInputHint || ''}\n${text}`).slice(-2000).join('');
    }
    // A failed additional send must never cancel the already running task.
    return;
  }
  // Preserve the ended turn's frozen evidence when the user starts another turn quickly.
  if (previous?.completion) previous.completion.superseded = true;
  else clearTimeout(previous?.timer);
  const task: Task = { generation: observer.generation, sequence: ++sequence, inputHint: Array.from(text).slice(0, 2000).join(''), mixed: false, working: false, interrupted: false };
  // A submitted command that never enters observed working state is not a completed task.
  task.timer = setTimeout(() => { if (tasks.get(id) === task && !task.working) tasks.delete(id); }, 45_000);
  tasks.set(id, task);
  return task.sequence;
}

export function cancelSentinelSubmission(id: string, submittedSequence: number | undefined): void {
  const task = tasks.get(id);
  if (task && task.sequence === submittedSequence) { cancelCompletion(task); clearTimeout(task.timer); tasks.delete(id); }
}

/** Only rendered/native CLI status can establish real work, never optimistic Enter state. */
export function markSentinelWorking(id: string): void {
  const task = tasks.get(id);
  if (!enabled || !task || getTerminalObserver(id)?.generation !== task.generation) return;
  task.working = true;
  clearTimeout(task.timer); task.timer = undefined;
}

export function markSentinelInterrupt(id: string): void {
  const task = tasks.get(id);
  if (task?.working) task.interrupted = true;
}

export function markSentinelExit(id: string): void {
  const task = tasks.get(id);
  if (!enabled || !task?.working) return;
  clearTimeout(task.timer);
  cancelCompletion(task);
  settle(id, task, 'exited');
}

function cancelCompletion(task: Task): void {
  if (!task.completion) return;
  clearTimeout(task.timer); task.timer = undefined;
  task.completion = undefined;
  completions.delete(task);
}

function settle(id: string, task: Task, outcome: 'ended' | 'interrupted' | 'exited'): void {
  const observer = getTerminalObserver(id);
  const session = sessions.get(id);
  if (!observer || !session) return;
  const completion: Completion = { superseded: false, epoch, session: { ...session } };
  task.completion = completion;
  completions.set(task, id);
  const valid = () => enabled && epoch === completion.epoch && task.completion === completion
    && sessions.has(id) && getTerminalObserver(id)?.generation === task.generation;
  const header = `Approximate submission input hint (untrusted):\n${task.inputHint}\n${task.mixed
    ? `Observed combined activity: additional input or renewed work occurred without verified per-prompt boundaries. Inputs may be queued or steer the CLI. Do not present this as the completed result of the initial prompt alone. Evidence is incomplete.\nAdditional submitted/attempted input hints (untrusted; delivery is not verified):\n${task.additionalInputHint || '[No additional input captured]'}\n`
    : ''}Screen/scrollback may include earlier tasks; do not attribute old results to this turn without evidence.\nTerminal evidence:\n`;
  const freeze = (screen: Awaited<ReturnType<typeof observer.readScreen>>, history?: Awaited<ReturnType<typeof observer.readScrollback>>, stable = false) => {
    const raw = JSON.stringify({ screen: screen.lines.map(line => line.text), scrollback: history?.lines.map(line => line.text), activeBuffer: screen.bufferType });
    const available = 16_000 - Array.from(header).length;
    const chars = Array.from(raw);
    const fresh = screen.freshness;
    const complete = !task.mixed && stable && history?.startRow === 0 && !history.hasMore && screen.screenRevision === history.screenRevision
      && !fresh.gap && !fresh.failed && fresh.flushState === 'flushed'
      && !history.freshness.gap && !history.freshness.failed && history.freshness.flushState === 'flushed';
    completion.evidence = { text: header + chars.slice(-available).join(''), revision: screen.screenRevision,
      capturedAt: screen.capturedAt, complete: complete && chars.length <= available };
  };
  // Start capturing at the idle transition, before the next prompt can produce new output.
  const capture = (async () => {
    const screen = await observer.readScreen();
    if (!valid() || completion.superseded) return;
    freeze(screen);
    const history = await observer.readScrollback(undefined, 200);
    if (!valid() || completion.superseded) return;
    freeze(screen, history, true);
  })().catch(error => console.error('[Agent sentinel observation]', error));
  const attempt = async () => {
    if (!valid()) return;
    try {
      await capture;
      if (!valid()) return;
      if (!completion.superseded && outcome !== 'exited' && sessions.get(id)?.status !== 'idle') { cancelCompletion(task); return; }
      if (!completion.superseded) {
        await new Promise(resolve => setTimeout(resolve, 350));
        if (!valid()) return;
        try {
          const screen = await observer.readScreen();
          if (!valid()) return;
          if (!completion.superseded) {
            const history = await observer.readScrollback(undefined, 200);
            if (!valid()) return;
            // Never replace the old snapshot with output from a newly submitted turn.
            if (!completion.superseded) freeze(screen, history, completion.evidence?.revision === screen.screenRevision);
          }
        } catch (error) {
          if (completion.evidence) completion.evidence.complete = false;
          console.error('[Agent sentinel observation]', error);
        }
      }
      if (!valid() || (!completion.superseded && outcome !== 'exited' && sessions.get(id)?.status !== 'idle')) return;
      const evidence = completion.evidence?.text ?? header + 'No terminal evidence was captured before the next task or observation failure. Results are unverified.';
      const complete = !task.mixed && !completion.superseded && completion.evidence?.complete === true;
      // Remove before awaiting IPC: failures are uncertain, so never retry the same event.
      cancelCompletion(task);
      if (tasks.get(id) === task) tasks.delete(id);
      await invoke('agent_sentinel_report', { report: {
        sessionId: id, generation: task.generation, taskSequence: task.sequence,
        tool: completion.session.tool, title: completion.session.title, cwd: completion.session.cwd,
        observedAt: completion.evidence?.capturedAt ?? Date.now(),
        outcome, evidenceQuality: complete ? 'complete' : 'incomplete', evidence, language,
      } });
    } catch (error) {
      if (task.completion === completion) cancelCompletion(task);
      if (tasks.get(id) === task) tasks.delete(id);
      console.error('[Agent sentinel]', error);
    }
  };
  task.timer = setTimeout(() => { task.timer = undefined; void attempt(); }, outcome === 'exited' ? 0 : 650);
}
