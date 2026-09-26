// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ConversationMarkdown } from './ConversationMarkdown';
afterEach(cleanup);

it('uses real highlighting for a language-less terminal block, with a manual plain-text override', async () => {
  const view = render(<ConversationMarkdown text={'```\nconst answer = 42; // hello\n```'} terminal />);
  await waitFor(() => expect(view.container.querySelectorAll('[style*="--code-dark"]').length).toBeGreaterThan(2));
  expect(screen.getByRole('combobox', { name: '代码语言' }).textContent).toContain('javascript');
  expect(view.container.querySelector('pre')?.textContent).toBe('const answer = 42; // hello');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'text' } });
  expect(view.container.querySelector('[style*="--code-dark"]')).toBeNull();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'javascript' } });
  await waitFor(() => expect(view.container.querySelector('[style*="--code-dark"]')).not.toBeNull());
});
