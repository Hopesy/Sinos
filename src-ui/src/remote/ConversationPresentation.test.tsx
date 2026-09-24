// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationCode, ConversationMarkdown } from './ConversationMarkdown';
import { ConversationDiff } from './ConversationDiff';
import { ConversationToolGroup } from './ConversationToolGroup';
import { groupConversation } from './groupConversation';
import type { ConversationRow } from './conversationProjection';
import type { ChatMessage } from '../lib/chat-transcript';
import { clipboardWrite } from '../lib/clipboard';

vi.mock('../lib/clipboard', () => ({ clipboardWrite: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const tool = (id: string, status: ChatMessage['toolStatus'] = 'done'): ChatMessage => ({ id, role: 'tool', toolName: 'Read', toolStatus: status, content: JSON.stringify({ file_path: `/project/${id}.tsx` }) });

it('groups only adjacent native tools and retains source order, IDs and reply boundaries', () => {
  const first = tool('a'), second = tool('b');
  const rows: ConversationRow[] = [{ source: 'message', message: first }, { source: 'message', message: second }, { source: 'message', message: { id: 'reply', role: 'assistant', content: '接下来修改' } }, { source: 'message', message: tool('c') }, { source: 'projection', event: { id: 'live', kind: 'activity', text: '等待确认' } }, { source: 'message', message: tool('d') }];
  const grouped = groupConversation(rows);
  expect(grouped).toHaveLength(5);
  expect(grouped[0]).toEqual({ source: 'tools', id: 'native-a', messages: [first, second] });
  expect(rows).toHaveLength(6);
  const growing = groupConversation([...rows.slice(0, 2), { source: 'message', message: tool('new') }]);
  expect(growing[0].source === 'tools' && growing[0].id).toBe('native-a');
});

it('keeps expanded groups stable while statuses change and exposes failures when collapsed', () => {
  const messages = [tool('a'), tool('b', 'running')];
  const props = { cwd: '/project', activeIds: new Set(['b']), active: true };
  const view = render(<ConversationToolGroup messages={messages} {...props} />);
  const group = view.container.querySelector('.tool-group') as HTMLDetailsElement;
  expect(group.querySelector('summary')?.textContent).toContain('正在处理');
  group.open = true;
  view.rerender(<ConversationToolGroup messages={[messages[0], tool('b', 'failed')]} {...props} />);
  expect(view.container.querySelector('.tool-group')).toBe(group);
  expect(group.open).toBe(true);
  expect(group.querySelector('summary')?.textContent).toContain('1 项失败');
  view.rerender(<ConversationToolGroup messages={messages} {...props} active={false} />);
  expect(group.querySelector('summary')?.textContent).toContain('1/2 完成');
  expect(group.querySelector('.spin')).toBeNull();
});

it('copies exact code and reports a denied clipboard write without claiming success', async () => {
  const code = 'const markup = "<script>literal</script>";\n  keepIndent();';
  vi.mocked(clipboardWrite).mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
  const view = render(<ConversationCode code={code} language="unknown" />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制代码' })); });
  expect(screen.getByRole('status').textContent).toContain('复制失败');
  expect(screen.queryByText('已复制')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制代码' })); });
  expect(clipboardWrite).toHaveBeenLastCalledWith(code, { throwOnError: true });
  expect(screen.getByText('已复制')).toBeTruthy();
  expect(view.container.querySelector('script')).toBeNull();
  expect(view.container.querySelector('pre')?.textContent).toBe(code);
});

it('renders fenced code with a language and copy control while inline code stays inline', () => {
  const view = render(<ConversationMarkdown text={'使用 `count`。\n\n```tsx\nconst count = 1;\n```'} />);
  expect(view.container.querySelector('.conversation-code')).toBeTruthy();
  expect(view.container.querySelector('p code')?.textContent).toBe('count');
  expect(view.container.querySelector('pre')?.textContent).toBe('const count = 1;');
  expect(screen.getAllByRole('button', { name: '复制代码' })).toHaveLength(1);
});

it('shows a fragment diff with unchanged context and accurate addition/removal counts', () => {
  const view = render(<ConversationDiff before={'function App() {\n  return "old";\n}\n'} after={'function App() {\n  return "new";\n}\n'} />);
  expect(screen.getByText('修改片段')).toBeTruthy();
  expect(view.container.querySelector('.diff-heading .diff-added')?.textContent).toBe('+1');
  expect(view.container.querySelector('.diff-heading .diff-removed')?.textContent).toBe('−1');
  expect(view.container.querySelectorAll('.diff-line')).toHaveLength(4);
  expect(view.container.querySelector('.diff-line.removed')?.textContent).toContain('return "old";');
  expect(view.container.querySelector('.diff-line.added')?.textContent).toContain('return "new";');
});
