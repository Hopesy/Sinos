import { afterEach, expect, it, vi } from 'vitest';
import { createTerminalAgentStatus } from './terminal-agent-status';
afterEach(() => vi.useRealTimers());

it('keeps permissions waiting across idle titles and long gaps', () => {
  vi.useFakeTimers();
  const publish = vi.fn(); let menu = true;
  const state = createTerminalAgentStatus(publish, () => menu);
  state.screen('wait_input', true); state.native('idle');
  vi.advanceTimersByTime(5000);
  expect(publish.mock.calls).toEqual([['wait_input']]);
  menu = false; state.screen(null, true); vi.advanceTimersByTime(900);
  expect(publish).toHaveBeenLastCalledWith('idle');
});
it('does not end native work on screen silence but settles a cleared Kimi spinner', () => {
  vi.useFakeTimers(); const publish = vi.fn();
  const state = createTerminalAgentStatus(publish, () => false);
  state.native('working'); state.screen(null, true); vi.advanceTimersByTime(5000);
  expect(publish.mock.calls).toEqual([['working']]);
  state.native('idle'); state.screen('working', true); state.screen(null, true);
  vi.advanceTimersByTime(900); expect(publish).toHaveBeenLastCalledWith('idle');
});
it('bounds stale screen suppression and cancels disposal timers', () => {
  vi.useFakeTimers(); const publish = vi.fn();
  const state = createTerminalAgentStatus(publish, () => false);
  state.screen('working', true); state.native('idle');
  expect(publish.mock.calls).toEqual([['working']]);
  vi.advanceTimersByTime(900); expect(publish).toHaveBeenLastCalledWith('idle');
  state.submitted(); state.dispose(); publish.mockClear();
  vi.runAllTimers(); state.native('idle'); expect(publish).not.toHaveBeenCalled();
});
it('leaves OMP Enter navigation under native title authority', () => {
  const publish = vi.fn();
  const state = createTerminalAgentStatus(publish, () => false, true);
  state.native('wait_input'); state.submitted();
  expect(publish.mock.calls).toEqual([['wait_input']]);
});
