import type { IconTheme } from '../store/app-state';

/** Keep saved theme IDs stable while the artwork uses the current Sinos name. */
export function getIconPath(theme: IconTheme, name: string): string {
  const directory = theme === 'coffee' ? 'sinos' : theme;
  return `/icons/themes/${directory}/${name}`;
}

/** Shared Explorer/review file-type artwork, including the user's icon theme. */
export function getFileIconSrc(ext: string, theme: IconTheme): string {
  const icons: Record<string, string> = {
    rs: 'rs.svg', js: 'js.svg', jsx: 'jsx.svg', ts: 'ts.svg', tsx: 'tsx.svg',
    py: 'py.svg', go: 'go.svg', java: 'java.svg', c: 'c.svg', cpp: 'cpp.svg',
    h: 'cpp.svg', html: 'html.svg', css: 'css.svg', json: 'json.svg',
    md: 'md.svg', toml: 'toml.svg', sh: 'sh.svg', pyw: 'py.svg',
  };
  return getIconPath(theme, icons[ext.toLowerCase()] || 'file.svg');
}
