import { expect, it } from 'vitest';
import { highlightCode } from './highlightCode';

it('preserves exact source text with light and dark token colors using the JS engine', async () => {
  const code = 'const message = "<b>你好</b>";\nconsole.log(message);';
  const lines = await highlightCode(code, 'ts');
  expect(lines).not.toBeNull();
  expect(lines!.map(line => line.map(token => token.content).join('')).join('\n')).toBe(code);
  const colors = lines!.flat().map(token => token.variants.light.color);
  expect(new Set(colors).size).toBeGreaterThan(1);
  expect(lines!.flat().every(token => token.variants.dark.color)).toBe(true);
  expect(await highlightCode('plain', 'unsupported-language')).toBeNull();
  expect(await highlightCode('x'.repeat(24001), 'ts')).toBeNull();
});
