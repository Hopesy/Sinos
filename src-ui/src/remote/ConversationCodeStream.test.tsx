// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationCode } from './ConversationMarkdown';

const highlight = vi.hoisted(() => vi.fn(async (code: string) => code.split('\n').map(content => [{ content, variants: { light: { color: '#112233' }, dark: { color: '#aabbcc' } } }])));
vi.mock('./highlightCode', () => ({ highlightCode: highlight }));
afterEach(() => { cleanup(); vi.useRealTimers(); highlight.mockClear(); });

it('hides an empty code card until actual streamed content arrives', async () => {
  const view = render(<ConversationCode code={' \n '} language="text" />);
  expect(view.container.textContent).toBe('');
  expect(view.container.querySelector('pre, button')).toBeNull();
  expect(highlight).not.toHaveBeenCalled();
  view.rerender(<ConversationCode code="const x = 1;" language="ts" />);
  expect(view.container.querySelector('pre')?.textContent).toBe('const x = 1;');
});

it('highlights a continuously growing block and retains complete highlighted lines between chunks', async () => {
  vi.useFakeTimers();
  const view = render(<ConversationCode code={'const a = 1;\n'} language="js" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(highlight).toHaveBeenCalledTimes(1);
  expect(view.container.querySelectorAll('[style*="--code-light"]').length).toBeGreaterThan(0);
  for (let i = 0; i < 12; i++) {
    view.rerender(<ConversationCode code={`const a = 1;\nconst b = ${'x'.repeat(i + 1)}`} language="js" />);
    expect(view.container.querySelector('[style*="--code-light"]')?.textContent).toBe('const a = 1;');
    await act(async () => { await vi.advanceTimersByTimeAsync(25); });
  }
  expect(highlight.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(view.container.querySelector('pre')?.textContent).toBe('const a = 1;\nconst b = xxxxxxxxxxxx');
  view.rerender(<ConversationCode code="replacement" language="python" />);
  expect(view.container.querySelector('pre')?.textContent).toBe('replacement');
  expect(view.container.querySelector('[style*="--code-light"]')).toBeNull();
});
