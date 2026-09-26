// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TerminalConversation } from './TerminalConversation';
import { ConversationMarkdown } from './ConversationMarkdown';
import { claudeStartupAnimation as fixture } from './fixtures/claudeStartupAnimation';
import { projectConversation } from './conversationProjection';
afterEach(cleanup);
it('does not render right-aligned effort text as an empty-looking code card when the composer has a placeholder', async () => {
  const decoder = new TerminalConversation(fixture.cols, fixture.rows, 'claude');
  const view = render(<></>);
  try {
    const data = fixture.data.replace('❯\u00a0', '❯ Try "how does this code work?"');
    const projection = await decoder.write(data);
    view.rerender(<>{projection.events.map(e => <ConversationMarkdown key={e.id} text={e.text} terminal />)}</>);
    expect(view.container.querySelector('.conversation-code')).toBeNull();
    expect(view.container.textContent).not.toContain('/effort');
    expect(view.container.textContent).not.toContain('Try "how does this code work?"');
  } finally { decoder.dispose(); }
});
it('replays the isolated Claude startup', async () => {
  const decoder = new TerminalConversation(fixture.cols, fixture.rows, 'claude');
  const view = render(<></>);
  try {
    // Check the initial frame and every mascot repaint, not only the final
    // screen; the phone can subscribe at any point in the startup animation.
    const frames = fixture.data.split('\x1b[2;1H').map((frame, index) => (index ? '\x1b[2;1H' : '') + frame);
    for (const frame of frames) {
      const projection = await decoder.write(frame);
      view.rerender(<>{projection.events.map(e => <ConversationMarkdown key={e.id} text={e.text} terminal />)}</>);
      expect(view.container.querySelector('.conversation-code')).toBeNull();
      expect(view.container.textContent).not.toContain('/effort');
    }
  } finally { decoder.dispose(); }
});

it('preserves quoted effort controls and code examples', () => {
  const lines = ['```text', '    ◐ medium · /effort', '────────────────', '❯', '────────────────', '```'];
  expect(projectConversation(lines, lines.length - 1, 'claude').events.map(e => e.text).join('\n')).toContain('/effort');
  expect(projectConversation(['    ◐ medium · /effort'], 0, 'claude').events.map(e => e.text).join('\n')).toContain('/effort');
});

it('filters a startup frame before the composer is painted and keeps real code after the first prompt', () => {
  const header = ['           Claude Code v2.1.282', '           Opus 5.5 (1M context) · API Usage Billing', '           C:\\Projects\\demo', '', ' '.repeat(80) + '◐ medium · /effort'];
  expect(projectConversation(header, 4, 'claude').events).toEqual([]);
  const lines = [...header, '────────────────', '❯ Try "write a test"', '────────────────', '  ? for shortcuts', '', '❯ show the example', '● Here is the code:', '', '    console.log("hello");'];
  const projection = projectConversation(lines, lines.length - 1, 'claude');
  const view = render(<>{projection.events.map(event => <ConversationMarkdown key={event.id} text={event.text} terminal />)}</>);
  expect(view.container.querySelectorAll('.conversation-code')).toHaveLength(1);
  expect(view.container.querySelector('pre')?.textContent).toBe('console.log("hello");');
});
