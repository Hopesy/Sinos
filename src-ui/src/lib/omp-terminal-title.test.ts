// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { parseOmpTerminalTitle } from './omp-terminal-title';
import { TerminalConversation } from '../remote/TerminalConversation';

it.each([...':⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'])('recognizes OMP activity prefix %s without parsing the session label', frame => {
  expect(parseOmpTerminalTitle(`π ${frame} Fix ! > :`)).toEqual({ status: 'working', displayTitle: 'Fix ! > :' });
});
it('uses only the delimited native state prefix', () => {
  expect(parseOmpTerminalTitle('π ! Approve')).toEqual({ status: 'wait_input', displayTitle: 'Approve' });
  expect(parseOmpTerminalTitle('π > Ready')).toEqual({ status: 'idle', displayTitle: 'Ready' });
  for (const title of ['π: project', 'π !important', 'project π !', 'π', '']) {
    expect(parseOmpTerminalTitle(title)).toEqual({ status: 'idle', displayTitle: title });
  }
});
it('projects split OMP title frames to mobile activity', async () => {
  const decoder = new TerminalConversation(80, 24, 'omp');
  try {
    await decoder.write('\x1b]0;π : Thinking');
    expect((await decoder.write('\x07')).activity).toBe('working');
    expect((await decoder.write('\x1b]0;π ! Approve\x07')).activity).toBe('waiting');
    expect((await decoder.write('\x1b]0;π > Done\x07')).activity).toBe('idle');
  } finally { decoder.dispose(); }
});
