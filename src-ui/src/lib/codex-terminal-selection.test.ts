// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createCodexTerminalSelection } from './codex-terminal-selection';

it('copies a Codex-owned drag via SGR at its origin, without sending Ctrl+C or editing the draft', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  const selection = createCodexTerminalSelection(() => true, write);
  selection.observe('\x1b[<0;3;12M');
  expect(selection.read()).toBeUndefined();
  selection.observe('\x1b[<32;18;12M');
  selection.observe('\x1b[<0;18;12m');
  const copy = selection.read();
  expect(copy).toBeTypeOf('function');
  await copy!();
  expect(write).toHaveBeenCalledExactlyOnceWith('\x1b[<2;3;12M\x1b[<2;3;12m');
  expect(selection.read()).toBeUndefined();
});

it('supports word/line selection by repeated clicks and keeps the ordinary click unselected', () => {
  const selection = createCodexTerminalSelection(() => true, vi.fn());
  selection.observe('\x1b[<0;3;12M\x1b[<0;3;12m');
  expect(selection.read()).toBeUndefined();
  selection.observe('\x1b[<0;3;12M\x1b[<0;3;12m');
  expect(selection.read()).toBeTypeOf('function');
  selection.observe('\x1b[<0;7;14M');
  expect(selection.read()).toBeUndefined();
});

it('does not guess a selection from hover or wheel and drops one after typing or terminal-mode exit', () => {
  let active = true;
  const selection = createCodexTerminalSelection(() => active, vi.fn());
  selection.observe('\x1b[<35;3;12M\x1b[<64;3;12M');
  expect(selection.read()).toBeUndefined();
  selection.observe('\x1b[<0;3;12M\x1b[<32;18;12M\x1b[<0;18;12m');
  selection.observe('\x1b[<65;3;12M');
  expect(selection.read()).toBeTypeOf('function');
  selection.observe('new draft');
  expect(selection.read()).toBeUndefined();
  selection.observe('\x1b[<0;3;12M\x1b[<32;18;12M');
  active = false;
  expect(selection.read()).toBeUndefined();
});

it('never delegates Claude/shell clicks and retains a retry after a failed PTY write', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
  const other = createCodexTerminalSelection(() => false, write);
  other.observe('\x1b[<0;3;12M\x1b[<32;18;12M');
  expect(other.read()).toBeUndefined();
  const codex = createCodexTerminalSelection(() => true, write);
  codex.observe('\x1b[<0;3;12M\x1b[<32;18;12M');
  await expect(codex.read()!()).rejects.toThrow('write failed');
  await codex.read()!();
  expect(write).toHaveBeenCalledTimes(2);
});

it('retains Codex selections across Windows IME focus reports and terminal queries', () => {
  const selection = createCodexTerminalSelection(() => true, vi.fn());
  selection.observe('\x1b[<0;3;12M\x1b[<32;18;12M\x1b[<0;18;12m');
  for (const report of ['\x1b[O', '\x1b[I', '\x1b[27;3R', '\x1b[?1;2c']) {
    selection.observe(report);
    expect(selection.read()).toBeTypeOf('function');
  }
});

it('does not clear a newer selection when a previous asynchronous copy finishes', async () => {
  let done!: () => void;
  const write = vi.fn(() => new Promise<void>(resolve => { done = resolve; }));
  const selection = createCodexTerminalSelection(() => true, write);
  selection.observe('\x1b[<0;3;12M\x1b[<32;18;12M\x1b[<0;18;12m');
  const copying = selection.read()!();
  selection.observe('\x1b[<0;8;16M\x1b[<32;20;16M\x1b[<0;20;16m');
  done(); await copying;
  expect(selection.read()).toBeTypeOf('function');
});
