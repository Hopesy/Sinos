// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VirtualList } from './VirtualList';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('bounds mounted rows across a 50000-file list and reaches the last file', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const items = Array.from({ length: 50_000 }, (_, i) => ({ key: String(i) }));
  const view = render(<VirtualList items={items} renderItem={item => <button>{item.key}</button>} />);
  const scroller = view.container.querySelector('[data-virtual-list]') as HTMLDivElement;
  Object.defineProperty(scroller, 'clientHeight', { value: 640 });
  for (const top of [0, 32000, 800000, 1599360]) {
    await act(async () => { scroller.scrollTop = top; fireEvent.scroll(scroller); });
    expect(view.container.querySelectorAll('button').length).toBeLessThanOrEqual(36);
  }
  expect(view.getByText('49999')).toBeTruthy();
  view.rerender(<VirtualList items={items.slice(0, 5)} renderItem={item => <button>{item.key}</button>} />);
  expect(view.getByText('0')).toBeTruthy();
  expect(view.container.querySelectorAll('button')).toHaveLength(5);
});
