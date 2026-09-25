import { useEffect, useState, type CSSProperties } from 'react';
import { THEME_COLORS } from '../lib/personalization';
import type { ThemeColor, ThemeMode } from '../store/app-state';
import { storageRead, storageWrite } from './client';

export function usePhoneAppearance() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const value = storageRead('theme-mode', storageRead('theme', 'system'));
    return value === 'dark' || value === 'light' ? value : 'system';
  });
  const [color, setColor] = useState<ThemeColor>(() =>
    THEME_COLORS.find(item => item.code === storageRead('theme-color'))?.code ?? 'obsidian');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const theme = mode === 'system' ? systemDark ? 'dark' : 'light' : mode;
  const palette = THEME_COLORS.find(item => item.code === color)!;
  const light = theme === 'light';
  const background = light ? palette.daySwatch : palette.swatch;
  const accent = light ? palette.dayRing : palette.ring;
  useEffect(() => {
    storageWrite('theme-mode', mode); storageWrite('theme-color', color);
    storageWrite('theme', theme);
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
  }, [mode, color, theme, background]);
  const style = {
    '--m-bg': background, '--m-terminal': background,
    '--m-surface': `color-mix(in srgb, ${background} ${light ? 35 : 94}%, white)`,
    '--m-raised': `color-mix(in srgb, ${background} ${light ? 85 : 88}%, ${light ? 'black' : 'white'})`,
    '--m-text': light ? '#252525' : '#e7e7e7',
    '--m-muted': light ? '#515761' : '#adb2bb',
    '--m-subtle': light ? '#5b6069' : '#a4a9b2',
    '--m-border': `color-mix(in srgb, ${accent} ${light ? 23 : 26}%, ${background})`,
    '--m-accent': accent, '--m-on-accent': light ? '#fff' : '#111',
    '--m-tint': `color-mix(in srgb, ${accent} 14%, ${background})`,
    '--m-code': light ? '#252525' : '#e7e7e7',
  } as CSSProperties;
  return { mode, setMode, color, setColor, theme, style };
}
