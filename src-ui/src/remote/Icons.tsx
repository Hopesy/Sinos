import type { CSSProperties } from 'react';

const paths = {
  terminal: 'm5 6 5 6-5 6m8 0h6',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7Z',
  changes: 'M6 3v12a5 5 0 0 0 5 5h5M18 3v8a5 5 0 0 1-5 5H6M3 3h6m6 0h6m-5 14 3 3-3 3',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  back: 'm14 5-7 7 7 7',
  close: 'm6 6 12 12M6 18 18 6',
  more: 'M5 11v2m7-2v2m7-2v2',
  send: 'm5 11 7-7 7 7M12 4v16',
  refresh: 'M20 7v5h-5M4 17v-5h5M5.5 7a8 8 0 0 1 13-1L20 9M4 15l1.5 3a8 8 0 0 0 13-1',
  monitor: 'M3 4h18v13H3V4Zm9 13v4m-4 0h8',
  check: 'm5 12 4 4L19 6',
  file: 'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8m-8 4h6',
  search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11Z',
  pause: 'M8 5v14M16 5v14',
  play: 'm8 4 12 8-12 8V4Z',
  stop: 'M5 5h14v14H5Z',
  expand: 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6',
  keyboard: 'M2 6h20v13H2V6Zm3 4h1m3 0h1m3 0h1m3 0h2M5 14h1m3 0h10',
  link: 'm9 15 6-6m-7 3-3 3a4 4 0 0 0 6 6l3-3m-4-12 3-3a4 4 0 0 1 6 6l-3 3',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  external: 'M14 3h7v7M21 3 10 14M10 5H3v16h16v-7',
  edit: 'm15 3 6 6-11 11-7 1 1-7L15 3Zm-2 2 6 6',
  save: 'M4 3h13l4 4v14H3V3h1Zm3 0v7h10V3M7 21v-7h10v7',
  wifi: 'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0m-4 4h.01',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
