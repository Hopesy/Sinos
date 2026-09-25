import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalInteractionResponder } from './terminal-interaction-response';
import { parseTerminalInteraction, type TerminalInteraction } from './terminal-interaction';

function setup(mode: 'digit' | 'vertical' | 'direct-text' = 'digit') {
  const parsed = parseTerminalInteraction([
    { text: 'Choose a color?', bold: true },
    { text: '❯1. Red', bold: false },
    { text: ' 2. Blue', bold: false },
    { text: ' 3. Type something.', bold: false },
    { text: 'Enter to select · ↑/↓ to navigate · Esc to cancel', bold: false },
  ], 'claude')!;
  let current: TerminalInteraction | null = { ...parsed, responseMode: mode };
  let live = true;
  const write = vi.fn<(data: string) => Promise<void>>().mockResolvedValue(undefined);
  const submitted = vi.fn();
  const responder = createTerminalInteractionResponder({
    read: () => current, isLive: () => live, applicationCursor: () => true,
    bracketedPaste: () => true, write, submitted,
  });
  const request = { fingerprint: parsed.fingerprint, optionCount: 3, optionIndex: 1 };
  return {
    ...responder, write, submitted, request,
    setCurrent: (value: TerminalInteraction | null) => { current = value; },
    changeQuestion: () => { current = { ...parsed, fingerprint: 'next-question' }; },
    close: () => { live = false; },
  };
}

afterEach(() => vi.useRealTimers());

describe('live interaction responses', () => {
  it('uses numeric shortcuts without sending an extra Enter', async () => {
    const target = setup();
    expect(await target.respond(target.request)).toBe(true);
    expect(target.write.mock.calls).toEqual([['2']]);
  });

  it('uses application cursor navigation and Enter for vertical selectors', async () => {
    const target = setup('vertical');
    expect(await target.respond(target.request)).toBe(true);
    expect(target.write.mock.calls).toEqual([['\x1bOB\r']]);
  });

  it('rejects stale cards, missing frames and changed option counts', async () => {
    const target = setup();
    expect(await target.respond({ ...target.request, optionCount: 9 })).toBe(false);
    target.changeQuestion();
    expect(await target.respond(target.request)).toBe(false);
    target.setCurrent(null);
    expect(await target.respond(target.request)).toBe(false);
    expect(target.write).not.toHaveBeenCalled();
  });

  it('does not accept repeated clicks while a write is pending', async () => {
    const target = setup();
    const first = target.respond(target.request);
    expect(await target.respond(target.request)).toBe(false);
    expect(await first).toBe(true);
    expect(target.write).toHaveBeenCalledTimes(1);
  });

  it('does not consume a card when the PTY write fails', async () => {
    const target = setup();
    target.write.mockRejectedValueOnce(new Error('closed PTY'));
    expect(await target.respond(target.request)).toBe(false);
    expect(target.submitted).not.toHaveBeenCalled();
  });

  it('separates selector, bracketed text and submit into distinct writes', async () => {
    vi.useFakeTimers();
    const target = setup();
    const result = target.respond({ ...target.request, optionIndex: 2, customText: 'A\nB' });
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    expect(target.write.mock.calls).toEqual([['3'], ['\x1b[200~A\rB\x1b[201~'], ['\r']]);
  });

  it('submits direct text without a selector digit', async () => {
    vi.useFakeTimers();
    const target = setup('direct-text');
    const result = target.respond({ ...target.request, optionIndex: 2, customText: 'Green' });
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    expect(target.write.mock.calls).toEqual([['\x1b[200~Green\x1b[201~'], ['\r']]);
  });

  it('cancels delayed text when the target is disposed', async () => {
    vi.useFakeTimers();
    const target = setup();
    const result = target.respond({ ...target.request, optionIndex: 2, customText: 'Green' });
    await Promise.resolve();
    target.dispose();
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(target.write.mock.calls).toEqual([['3']]);
  });

  it('stops custom text when the process exits or another question arrives', async () => {
    vi.useFakeTimers();
    for (const change of ['close', 'changeQuestion'] as const) {
      const target = setup();
      const result = target.respond({ ...target.request, optionIndex: 2, customText: 'Green' });
      await Promise.resolve();
      target[change]();
      await vi.runAllTimersAsync();
      expect(await result).toBe(false);
      expect(target.write.mock.calls).toEqual([['3']]);
    }
  });
});
