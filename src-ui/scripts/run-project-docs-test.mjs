import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = [
  'AGENTS.md', 'README.md', '.github/CONTRIBUTING.md',
  'docs/README.md', 'docs/ARCHITECTURE.md', 'docs/REPO_COLLAB_GUIDE.md',
  'docs/PLANS_GUIDE.md', 'docs/HISTORY_GUIDE.md',
];
function collect(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = `${relative}/${entry.name}`;
    if (entry.isDirectory()) collect(next);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(next);
  }
}
for (const directory of ['docs/design', 'docs/exec-plans', 'docs/histories']) collect(directory);
let localLinks = 0;
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const ignore = spawnSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: root });
  assert.equal(ignore.status, 1, `Shared documentation is ignored: ${file}`);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)|\b(?:src|href)="([^"]+)"/g)) {
    const destination = (match[1] ?? match[2]).split(/\s+["']/)[0];
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(destination)) continue;
    const local = decodeURIComponent(destination.split(/[?#]/)[0]);
    if (!local) continue;
    assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), local)), `${file}: broken link ${destination}`);
    localLinks++;
  }
  for (const match of text.matchAll(/^superseded_by:\s*(\S+)\s*$/gm)) {
    const [target, anchor] = match[1].split('#');
    const destination = target || file;
    const resolved = path.resolve(root, destination);
    assert.ok(resolved.startsWith(root), 'Decision target must stay inside the repository');
    const replacement = fs.readFileSync(resolved, 'utf8');
    if (anchor) assert.ok(replacement.split(/\r?\n/).some(line =>
      /^#{1,6} /.test(line) && (line.replace(/^#+\s*/, '').trim().toLowerCase() === anchor || line.includes(`{#${anchor}}`))), `${file}: missing replacement decision ${match[1]}`);
  }
}
for (const old of [
  'AGENT.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'screenshot', 'branding',
  'docs/AGENT.md', 'docs/history', 'docs/performance',
  '.github/UPSTREAM_SYNC.md', '.github/CLAUDE_MOBILE_ADAPTATION.md', '.github/CODEX_MOBILE_ADAPTATION.md',
]) assert.equal(fs.existsSync(path.join(root, old)), false, `Retired entry remains: ${old}`);
for (const privatePath of ['docs/private-design.md', 'docs/design/private-data.json', '.Sinos-temp/probe.md', '.claude/settings.json']) {
  assert.equal(spawnSync('git', ['check-ignore', '--no-index', '-q', privatePath], { cwd: root }).status, 0, `Local-only material is exposed: ${privatePath}`);
}
for (const legal of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md']) assert.ok(fs.existsSync(path.join(root, legal)));
const source = fs.readFileSync(path.join(root, 'scripts/generate-sinos-icons.py'), 'utf8');
assert.equal((source.match(/ROOT \/ "icons" \/ "branding"/g) ?? []).length, 2, 'Icon generator must use the canonical brand source');
assert.ok(fs.existsSync(path.join(root, 'icons/branding/sinos-icon.png')));
console.log(`PASS: ${files.length} shared documents, ${localLinks} local links, decision navigation, retired paths, ignore rules and packaging sources.`);
