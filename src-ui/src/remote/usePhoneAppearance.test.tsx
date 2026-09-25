// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePhoneAppearance } from './usePhoneAppearance';
import { AppProvider, useAppState } from '../store/app-state';

let dark = false;
let listeners: Set<() => void>;
beforeEach(() => {
  localStorage.clear(); dark = false; listeners = new Set();
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return dark; },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('follows live system changes and preserves manual mode and palette on remount', () => {
  const view = renderHook(usePhoneAppearance);
  expect(view.result.current.theme).toBe('light');
  act(() => { dark = true; listeners.forEach(fn => fn()); });
  expect(view.result.current.theme).toBe('dark');
  act(() => { view.result.current.setMode('light'); view.result.current.setColor('mint'); });
  expect(view.result.current.style['--m-bg' as keyof typeof view.result.current.style]).toBeTruthy();
  view.unmount(); expect(listeners.size).toBe(0);
  const restored = renderHook(usePhoneAppearance);
  expect(restored.result.current).toMatchObject({ mode: 'light', color: 'mint', theme: 'light' });
});
it('retains an existing mobile dark-mode preference', () => {
  localStorage.setItem('sinos-mobile-theme', 'dark');
  expect(renderHook(usePhoneAppearance).result.current).toMatchObject({ mode: 'dark', theme: 'dark' });
});
it('migrates retired desktop colors while preserving light and explicit system modes', () => {
  localStorage.setItem('cc-theme', 'cobalt'); localStorage.setItem('cc-mode', 'system');
  const first = renderHook(useAppState, { wrapper: AppProvider });
  expect(first.result.current.state).toMatchObject({ currentTheme: 'indigo', themeMode: 'system' });
  first.unmount(); localStorage.clear(); localStorage.setItem('cc-theme', 'light');
  expect(renderHook(useAppState, { wrapper: AppProvider }).result.current.state).toMatchObject({ currentTheme: 'light', themeMode: 'light' });
});
