// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeferredConversationContent } from './DeferredConversationContent';
import { ConversationVisible } from './conversation-visibility';
import { MarkdownContent } from './MarkdownContent';

const syntax = vi.hoisted(() => ({ tokenize: vi.fn() }));
vi.mock('../../lib/shiki', () => ({ tokenizeByLang: syntax.tokenize, getShikiTheme: () => 'github-dark-default' }));
vi.mock('../../tauri', () => ({ commands: {} }));
const observers = new Set<ResizeObserver>();
beforeEach(() => {
  syntax.tokenize.mockReset();
  vi.stubGlobal('ResizeObserver', class {
    observe() { observers.add(this as unknown as ResizeObserver); }
    disconnect() { observers.delete(this as unknown as ResizeObserver); }
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 120 } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); observers.clear(); });

it('releases background rendering and observers while retaining its measured space', () => {
  const mount = vi.fn(), release = vi.fn();
  function Content() { useEffect(() => { mount(); return release; }, []); return <pre>Rendered output</pre>; }
  const tree = (visible: boolean) => <ConversationVisible.Provider value={visible}><DeferredConversationContent><Content /></DeferredConversationContent></ConversationVisible.Provider>;
  const view = render(tree(false));
  expect(mount).not.toHaveBeenCalled();
  view.rerender(tree(true));
  expect(mount).toHaveBeenCalledTimes(1); expect(observers.size).toBe(1);
  view.rerender(tree(false));
  expect(release).toHaveBeenCalledTimes(1); expect(observers.size).toBe(0);
  expect(view.container.querySelector('pre')).toBeNull();
  expect(view.container.firstElementChild?.getAttribute('style')).toBe('height: 120px;');
  view.rerender(tree(true));
  expect(mount).toHaveBeenCalledTimes(2);
  expect(view.container.firstElementChild?.getAttribute('style')).toBe('');
});

it('ignores late highlighting after hiding and renders the latest background text on return', async () => {
  const pending: Array<(tokens: { content: string; color: string }[][]) => void> = [];
  syntax.tokenize.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const tree = (visible: boolean, text: string) => <ConversationVisible.Provider value={visible}><MarkdownContent content={`\`\`\`js\n${text}\n\`\`\``} /></ConversationVisible.Provider>;
  const view = render(tree(true, 'before'));
  expect(syntax.tokenize).toHaveBeenCalledTimes(1);
  view.rerender(tree(false, 'after'));
  await act(async () => pending[0]([[{ content: 'stale tokens', color: 'red' }]]));
  expect(view.container.querySelector('.md-code')).toBeNull();
  expect(view.container.textContent).toBe('');
  expect(syntax.tokenize).toHaveBeenCalledTimes(1);
  view.rerender(tree(true, 'after'));
  expect(syntax.tokenize).toHaveBeenCalledTimes(2);
  expect(view.container.textContent).toBe('after');
  await act(async () => pending[1]([[{ content: 'after', color: 'green' }]]));
  expect(view.container.querySelector('span')?.style.color).toBe('green');
  expect(view.container.textContent).toBe('after');
});
