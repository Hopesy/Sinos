// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { installTerminalLinks } from './terminal-links';

const terminals: Terminal[] = [];
afterEach(() => { for (const term of terminals.splice(0)) term.dispose(); });
async function setup(text: string, cols = 80) {
  const term = new Terminal({ cols, rows: 10, allowProposedApi: true });
  terminals.push(term);
  let provider!: ILinkProvider;
  vi.spyOn(term, 'registerLinkProvider').mockImplementation(value => {
    provider = value;
    return { dispose() {} };
  });
  const open = vi.fn(async () => {});
  installTerminalLinks(term, open);
  await new Promise<void>(resolve => term.write(text, resolve));
  const links = (row: number) => new Promise<ILink[]>(resolve => provider.provideLinks(row, result => resolve(result ?? [])));
  return { term, open, links };
}

it('opens plain URLs on a left click without modifier keys and preserves query parameters', async () => {
  const uri = 'https://example.com/login?code=abc&state=50%25';
  const { links, open } = await setup(uri);
  const [link] = await links(1);
  expect(link.text).toBe(uri);
  link.activate(new MouseEvent('mouseup', { button: 0 }), link.text);
  expect(open).toHaveBeenCalledExactlyOnceWith(uri);
});

it('recognizes the full URL from either side of a soft wrap', async () => {
  const uri = 'https://example.com/very-long-path?one=1&two=2';
  const { links } = await setup('URL: ' + uri, 24);
  for (const row of [1, 2, 3]) {
    const [link] = await links(row);
    expect(link.text).toBe(uri);
    expect(link.range.start).toEqual({ x: 6, y: 1 });
    expect(link.range.end.y).toBe(3);
  }
});

it('maps a URL after wide characters and blank cells to the correct columns', async () => {
  const { links } = await setup('中文\t https://example.com，继续');
  const [link] = await links(1);
  expect(link.text).toBe('https://example.com');
  expect(link.range.start).toEqual({ x: 10, y: 1 });
});

it('routes OSC 8 links to the same opener, including file URLs', async () => {
  const { term, open } = await setup('');
  const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } };
  for (const uri of ['https://example.com/?a=1&b=2', 'file:///C:/my%20project/readme.md']) {
    term.options.linkHandler!.activate(new MouseEvent('mouseup', { button: 0 }), uri, range);
    expect(open).toHaveBeenLastCalledWith(uri);
  }
});

it('does not open on right click, text selection or an unsupported OSC 8 scheme', async () => {
  const { term, open, links } = await setup('https://example.com');
  const [link] = await links(1);
  link.activate(new MouseEvent('mouseup', { button: 2 }), link.text);
  term.options.linkHandler!.activate(new MouseEvent('mouseup'), 'javascript:alert(1)', link.range);
  vi.spyOn(term, 'hasSelection').mockReturnValue(true);
  link.activate(new MouseEvent('mouseup'), link.text);
  expect(open).not.toHaveBeenCalled();
});

it('recognizes local file URLs and excludes sentence punctuation', async () => {
  const { links } = await setup('file:///C:/project/readme.md.');
  expect((await links(1))[0].text).toBe('file:///C:/project/readme.md');
});
