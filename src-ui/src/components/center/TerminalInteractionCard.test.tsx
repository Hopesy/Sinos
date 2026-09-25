// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalInteractionCard } from './TerminalInteractionCard';
import type { TerminalInteraction } from '../../lib/terminal-interaction';
import type { TerminalInteractionResponse } from '../../lib/terminal-interaction-response';

const { respond } = vi.hoisted(() => ({ respond: vi.fn<(response: TerminalInteractionResponse) => Promise<boolean>>().mockResolvedValue(false) }));
vi.mock('../../lib/tab-actions', () => ({ getTabActions: () => ({ respondToInteraction: respond }) }));
vi.mock('../../i18n/useT', () => ({ useT: () => (key: string) => key }));
afterEach(() => { cleanup(); respond.mockClear(); });
const interaction: TerminalInteraction = {
  fingerprint: 'current-question', kind: 'question', title: 'Choose a color?',
  focusedPosition: 0, responseMode: 'digit',
  options: ['Red', 'Blue', 'Other'].map((label, position) => ({
    label, position, number: position + 1, focused: position === 0, acceptsText: position === 2,
  })),
};

it('sends the exact displayed question identity and reports IPC failures', async () => {
  render(<TerminalInteractionCard sessionId="test" interaction={interaction} keyboardEnabled />);
  fireEvent.click(screen.getByRole('button', { name: /Blue/ }));
  await screen.findByRole('status');
  expect(respond).toHaveBeenCalledWith({ fingerprint: 'current-question', optionCount: 3, optionIndex: 1 });
});

it('uses arrow/Enter selection only when this conversation has keyboard focus', async () => {
  const view = render(<TerminalInteractionCard sessionId="test" interaction={interaction} keyboardEnabled={false} />);
  fireEvent.keyDown(window, { key: '2' });
  expect(respond).not.toHaveBeenCalled();
  view.rerender(<TerminalInteractionCard sessionId="test" interaction={interaction} keyboardEnabled />);
  fireEvent.keyDown(window, { key: 'ArrowDown' });
  fireEvent.keyDown(window, { key: 'Enter' });
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(respond.mock.calls[0][0]).toMatchObject({ optionIndex: 1 });
});

it('preserves custom text on failure and does not consume numbers typed into it', async () => {
  render(<TerminalInteractionCard sessionId="test" interaction={interaction} keyboardEnabled />);
  fireEvent.click(screen.getByRole('button', { name: /Other/ }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Green 2' } });
  fireEvent.keyDown(input, { key: '2' });
  expect(respond).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByRole('status');
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ optionIndex: 2, customText: 'Green 2' }));
  expect((input as HTMLTextAreaElement).value).toBe('Green 2');
});
