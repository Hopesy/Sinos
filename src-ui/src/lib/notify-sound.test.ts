// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentStatus, ToolType } from '../store/app-state';

const started = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); localStorage.clear(); started.mockClear();
  vi.stubGlobal('AudioContext', class {
    currentTime = 0; state = 'running'; destination = {};
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { return { frequency: { value: 0 }, type: '', connect: (gain: unknown) => gain, start: started, stop() {} }; }
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const session = (agentStatus: AgentStatus, tool: ToolType = 'claude') => [{ id: 'session', tool, agentStatus }];

it('does not play completion between an idle title and a permission frame', async () => {
  const { initNotifySound } = await import('./notify-sound');
  initNotifySound(session('working')); initNotifySound(session('idle'));
  vi.advanceTimersByTime(100); expect(started).not.toHaveBeenCalled();
  initNotifySound(session('wait_input')); vi.advanceTimersByTime(1000);
  expect(started).toHaveBeenCalledTimes(4); // Only the two-note permission chime.
});
it('cancels pending completion when work resumes or the terminal closes', async () => {
  const { initNotifySound } = await import('./notify-sound');
  initNotifySound(session('working')); initNotifySound(session('idle'));
  initNotifySound(session('working')); vi.advanceTimersByTime(1000);
  expect(started).not.toHaveBeenCalled();
  initNotifySound(session('idle')); initNotifySound([]); vi.advanceTimersByTime(1000);
  expect(started).not.toHaveBeenCalled();
});
it.each(['codex', 'kimicode'] as const)('keeps %s startup silent and chimes once after submitted work settles', async tool => {
  const { initNotifySound, markNotifySoundPromptSubmitted } = await import('./notify-sound');
  initNotifySound(session('working', tool)); initNotifySound(session('idle', tool));
  vi.advanceTimersByTime(1000); expect(started).not.toHaveBeenCalled();
  markNotifySoundPromptSubmitted('session', tool);
  initNotifySound(session('working', tool)); initNotifySound(session('idle', tool));
  initNotifySound(session('idle', tool)); vi.advanceTimersByTime(1000);
  expect(started).toHaveBeenCalledTimes(6);
});
