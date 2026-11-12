/** Terminal URL matching with `node scripts/run-terminal-links-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/terminal-theme.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, navigator: { userAgent: '' }, window: {}, document: {} });
const { LINK_RE, trimLink } = module.exports;
const urls = text => [...text.matchAll(LINK_RE)].map(match => trimLink(match[0]));
assert.deepEqual(urls('打开是 **http://127.0.0.1:5199/web-demo/showcase.html**。我在'), ['http://127.0.0.1:5199/web-demo/showcase.html'], 'bold markers around a URL stay out of it');
assert.deepEqual(urls('see _https://example.com/a_ and (https://example.com/b), then https://example.com/c.'), ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
assert.deepEqual(urls('https://example.com/a*b'), ['https://example.com/a*b'], 'an asterisk inside a URL stays');
console.log('OK: terminal URLs leave out trailing punctuation and Markdown emphasis');

const { buildXtermTheme } = module.exports;
for (const isDark of [true, false]) {
  const agent = buildXtermTheme('sakura', false, undefined, false, true, isDark);
  const shell = buildXtermTheme('sakura', false, undefined, true, true, isDark);
  const hidden = buildXtermTheme('sakura', true, undefined, false, false, isDark);
  assert.equal(shell.cursor, shell.foreground, 'raw shells keep their foreground caret');
  assert.notEqual(agent.cursor, agent.foreground, 'agent carets retain the selected theme accent');
  assert.equal(hidden.cursor, hidden.background, 'repainting hides the cursor even over wallpaper');
  assert.equal(hidden.cursorAccent, agent.background, 'block-cursor contrast retains the opaque theme background');
}
console.log('OK: terminal theme extraction preserves raw-shell, themed-agent and transient hidden cursor colors');

const links = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/terminal-links.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'terminal-link-addon', setup(b) {
  b.onResolve({ filter: /^@xterm\/addon-web-links$/ }, () => ({ path: 'addon', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class WebLinksAddon { constructor(activate, options) { this.activate = activate; this.options = options; } }' }));
} }] });
const linkModule = { exports: {} };
runInNewContext(links.outputFiles[0].text, { module: linkModule, exports: linkModule.exports, console, URL });
const opened = []; let selected = false, addon;
const term = { options: {}, hasSelection: () => selected, loadAddon(value) { addon = value; } };
linkModule.exports.installTerminalLinks(term, async url => opened.push(url));
const event = button => ({ button, preventDefault() {} });
addon.activate(event(0), 'https://example.com/test**');
assert.deepEqual(opened, ['https://example.com/test'], 'native activation strips prose emphasis too');
term.options.linkHandler.activate(event(0), 'javascript:alert(1)');
term.options.linkHandler.activate(event(0), 'data:text/html,unsafe');
addon.activate(event(2), 'https://example.com/context-menu');
selected = true; addon.activate(event(0), 'https://example.com/selection');
assert.equal(opened.length, 1, 'unsafe OSC 8, context menus and selections never open a URL');
selected = false; term.options.linkHandler.activate(event(0), 'file:///D:/test.html');
assert.equal(opened.at(-1), 'file:///D:/test.html');
console.log('OK: native terminal opener preserves URL scheme, selection and context-menu guards');
