// Global controls keep the arrow. Text entry, resize handles and Sinos's scoped
// xterm link-hover affordance are the only important cursor overrides.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src', import.meta.url));
const allowed = new Set(['default', 'text', 'col-resize', 'row-resize', 'ns-resize', 'ew-resize']);
const offenders = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.css')) {
      const text = await readFile(path, 'utf8');
      let scanned = text;
      if (entry.name === 'TierTerminal.css') {
        // Sinos retains the existing xterm link-hover affordance. The exception
        // is restricted to xterm's active-link class, never a generic app control.
        const linkHover = /\.tier-terminal \.xterm\.xterm-cursor-pointer,\s*\.tier-terminal \.xterm\.xterm-cursor-pointer \*\s*\{\s*cursor:\s*pointer\s*!important;\s*\}/g;
        assert.equal([...text.matchAll(linkHover)].length, 1, 'terminal link hover keeps its scoped pointer');
        scanned = text.replace(linkHover, '');
      }
      for (const match of scanned.matchAll(/cursor\s*:\s*([a-z-]+)\s*!important/g)) {
        if (!allowed.has(match[1])) offenders.push(`${path.slice(root.length + 1)}:${text.slice(0, match.index).split('\n').length} cursor: ${match[1]}`);
      }
    }
  }
}
await walk(root);
assert.deepEqual(offenders, [], 'only text and resize cursors may override the arrow');
console.log('ok cursor stays an arrow except text entry, resize handles and scoped terminal links');
