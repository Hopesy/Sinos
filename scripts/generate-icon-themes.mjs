// Sinos file-tree artwork. Brand geometry comes from icons/branding/sinos-icon.svg.
// Upstream themes are maintained by fetch-icon-themes.mjs; outline keeps its existing art.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'src-ui/public/icons/themes/sinos');
const source = readFileSync(join(root, 'icons/branding/sinos-icon.svg'), 'utf8');
const mark = source.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/)[1]
  .replace(/<(title|desc)>[\s\S]*?<\/\1>/g, '');
const insetMark = `<svg x="12" y="12" width="13" height="13" viewBox="0 0 1024 1024">${mark}</svg>`;
const folder = open => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M3 8a3 3 0 0 1 3-3h6l3 3h11a3 3 0 0 1 3 3v15H3Z" fill="#171717" stroke="#999" stroke-width="1.2"/>
  ${open ? '<path d="M2 13h28l-3 14H5Z" fill="#454545" stroke="#aaa" stroke-width="1.2"/>' : ''}
  ${insetMark}
</svg>\n`;

const languages = {
  js: ['JS', '#F7DF1E'], ts: ['TS', '#6CA7ED'], tsx: ['TSX', '#6CA7ED'], jsx: ['JSX', '#61DAFB'],
  py: ['PY', '#FFD43B'], rs: ['RS', '#E97C5E'], go: ['GO', '#00ADD8'], java: ['JV', '#F89820'],
  c: ['C', '#8CA5E0'], cpp: ['C++', '#6CA7ED'], html: ['H', '#F07959'], css: ['CSS', '#70A1F7'],
  json: ['{}', '#E0C66A'], md: ['MD', '#D9D9D9'], sh: ['SH', '#73C972'], toml: ['TML', '#E0A458'],
};
const languageTile = (letters, color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="1" y="1" width="30" height="30" rx="6" fill="#171717" stroke="#777"/>
  <text x="16" y="16" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,sans-serif"
    font-size="${letters.length >= 3 ? 12 : letters.length === 2 ? 16 : 20}" font-weight="800" fill="${color}">${letters}</text>
</svg>\n`;

mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'folder-closed.svg'), folder(false));
writeFileSync(join(directory, 'folder-open.svg'), folder(true));
writeFileSync(join(directory, 'file.svg'), source);
for (const [extension, [letters, color]] of Object.entries(languages)) {
  writeFileSync(join(directory, `${extension}.svg`), languageTile(letters, color));
}
console.log(`Sinos: ${Object.keys(languages).length + 3} file-tree icons generated.`);
