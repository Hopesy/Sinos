// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { parseClaudeTerminalTitle } from './claude-terminal-title';
import { TerminalConversation } from '../remote/TerminalConversation';

it.each(['◐', '◑', '⠂', '⠐'])('recognizes Claude activity frame %s without changing the display title', frame => {
  expect(parseClaudeTerminalTitle(`  ${frame}  检查移动端  `)).toEqual({
    status: 'working', displayTitle: '检查移动端',
  });
});

it.each(['', 'Claude Code', 'Notes ◐ inside', '◐prefix is not a status'])('preserves ordinary title %j', title => {
  expect(parseClaudeTerminalTitle(title)).toEqual({ status: 'idle', displayTitle: title });
});

it('keeps mobile activity stable across title animation frames and returns to idle', async () => {
  const decoder = new TerminalConversation(80, 24, 'claude');
  try {
    for (const frame of ['◐', '◑', '◐', '⠂', '⠐']) {
      const result = await decoder.write(`\x1b]0;${frame} 检查移动端\x07`);
      expect(result.activity).toBe('working');
      expect(result.events).toEqual([]);
    }
    expect((await decoder.write('\x1b]0;◑ next turn')).activity).toBe('working');
    expect((await decoder.write('\x07')).activity).toBe('working');
    expect((await decoder.write('\x1b]0;✳ next turn\x07')).activity).toBe('idle');
    decoder.reset();
    expect((await decoder.write('')).activity).toBeUndefined();
  } finally {
    decoder.dispose();
  }
});
