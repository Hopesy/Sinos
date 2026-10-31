import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/lib/conversation-links.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { conversationLink: link } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const cwd = 'D:\\Test Project';
for (const [href, path] of [
  ['simple-web-test/index.html', 'D:/Test Project/simple-web-test/index.html'],
  ['./test%20page.html', 'D:/Test Project/test page.html'],
  ['../shared/readme.md#L12', 'D:/shared/readme.md'],
  ['file:///D:/Test%20Project/index.html', 'D:/Test Project/index.html'],
  ['D:\\Test Project\\src\\app.ts:12:3', 'D:/Test Project/src/app.ts'],
  ['D:/Test%20Project/src/app.ts#L12', 'D:/Test Project/src/app.ts'],
  ['file:///home/user/a%20b.html', '/home/user/a b.html'],
  ['file://server/share/readme.md', '//server/share/readme.md'],
  ['./%2520.html', 'D:/Test Project/%20.html'],
  ['D:/', 'D:/'],
]) assert.deepEqual(link(href, cwd), { target: path, local: true }, href);
assert.deepEqual(link('https://example.com/?a=1&b=2', cwd), { target: 'https://example.com/?a=1&b=2', local: false });
for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'vbscript:open()', 'tauri://localhost', '#heading', '%invalid', '']) assert.equal(link(href, cwd), null, href);
assert.equal(link('relative.html', null), null);
assert.deepEqual(link('/home/user/index.html', null), { target: '/home/user/index.html', local: true });
console.log('ok local, relative, file URL, Windows/POSIX paths, encoding, source lines and unsupported schemes');
