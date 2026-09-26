// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TerminalConversation } from './TerminalConversation';
import { ConversationMarkdown } from './ConversationMarkdown';
import { claudeStartupAnimation as fixture } from './fixtures/claudeStartupAnimation';
import { projectConversation } from './conversationProjection';
afterEach(cleanup);
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
