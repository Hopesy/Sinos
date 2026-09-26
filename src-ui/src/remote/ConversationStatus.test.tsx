// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConversationStatus } from './ConversationStatus';
import { ConversationTool } from './ConversationTool';
afterEach(cleanup);

it.each([
  ['上下文已用 18%', 18], ['上下文剩余 80%', 20], ['Context 88% left', 12],
  ['0% context left', 100], ['100% context left', 0], ['3% | demo 3000 tokens', 3],
])('renders %s as a usage ring', (line, used) => {
  const view = render(<ConversationStatus status={{ model: 'Model', lines: [line] }} />);
  expect(screen.getByRole('meter', { name: '上下文占用' }).getAttribute('aria-valuenow')).toBe(String(used));
  expect(view.container.querySelector('.status-title')?.textContent || '').not.toContain('%');
  expect(view.container.querySelector('details, summary')).toBeNull();
  expect(view.container.querySelector('.context-ring-value')?.getAttribute('stroke-dasharray')).toBe(`${used} 100`);
});

it('uses structured usage over stale VT values, and does not invent missing usage', () => {
  const view = render(<ConversationStatus status={{ model: 'Opus', lines: ['5% | demo'], contextUsed: 36 }} />);
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('36');
  expect(screen.getByText('36%')).toBeTruthy();
  expect(view.container.textContent).not.toContain('demo');
  view.rerender(<ConversationStatus status={{ lines: ['Build 40% complete'] }} />);
  expect(screen.queryByRole('meter')).toBeNull();
  expect(view.container.querySelector('.context-percent')).toBeNull();
});

it('shows only model and usage in the footer, with a visible percentage', () => {
  const path = 'C:\\Projects\\Sinos';
  const view = render(<ConversationStatus status={{ model: 'gpt-5.4 high', lines: [path], contextUsed: 22 }} />);
  const strip = screen.getByRole('group', { name: '会话状态' });
  expect(strip.textContent).toContain('gpt-5.4 high');
  expect(strip.textContent).not.toContain('Sinos');
  expect(screen.getByText('22%')).toBeTruthy();
  expect(strip.textContent).not.toContain('目录');
  expect(screen.queryByLabelText(path)).toBeNull();
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('22');
  expect(view.container.querySelector('details, summary')).toBeNull();
});

it('expands reasoning with one heading and one animated circle, stopping after completion', () => {
  const message = { id: 'thinking', role: 'reasoning' as const, content: '我先检查现有实现。', toolStatus: 'running' as const };
  const view = render(<ConversationTool message={message} cwd="/project" active />);
  expect(screen.getAllByText('思考过程')).toHaveLength(1);
  expect(view.container.querySelector('details')?.open).toBe(true);
  expect(view.container.querySelectorAll('.lucide-circle-dashed')).toHaveLength(1);
  expect(view.container.querySelectorAll('.spin')).toHaveLength(1);
  expect(view.container.querySelector('.tool-detail-heading')).toBeNull();
  expect(screen.getByText(message.content)).toBeTruthy();
  view.rerender(<ConversationTool message={{ ...message, toolStatus: 'done' }} cwd="/project" active={false} />);
  expect(view.container.querySelector('.spin')).toBeNull();
});
