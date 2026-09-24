// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMobileViewport } from './useMobileViewport';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('follows the visible keyboard area and removes listeners when leaving the phone UI', async () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  function App() { useMobileViewport(); return null; }
  const view = render(<App />);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--m-viewport-height')).toBe('800px');
  viewport.height = 420; viewport.offsetTop = 32;
  await act(async () => { viewport.dispatchEvent(new Event('resize')); await vi.runOnlyPendingTimersAsync(); });
  expect(style.getPropertyValue('--m-viewport-height')).toBe('420px');
  expect(style.getPropertyValue('--m-viewport-top')).toBe('32px');
  view.unmount();
  viewport.dispatchEvent(new Event('resize')); await vi.runOnlyPendingTimersAsync();
  expect(style.getPropertyValue('--m-viewport-height')).toBe('');
});
