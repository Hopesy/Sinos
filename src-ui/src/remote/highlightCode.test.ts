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
  expect(await highlightCode('x'.repeat(120001), 'ts')).toBeNull();
  expect(await highlightCode('x'.repeat(24001), 'ts')).toBeNull();
});

it.each([
  ['java', 'public class Demo { public static void main(String[] args) { System.out.println("hello"); } }'],
  ['c++', '#include <iostream>\nint main() { std::cout << "hello"; }'],
  ['c#', 'using System;\nConsole.WriteLine("hello");'],
  ['go', 'package main\nfunc main() { println("hello") }'],
  ['text', 'const answer = 42; // language lost in terminal projection'],
])('highlights %s through the actual lazy grammar and JavaScript engine', async (language, code) => {
  const lines = await highlightCode(code, language);
  expect(lines).not.toBeNull();
  expect(lines!.map(line => line.map(token => token.content).join('')).join('\n')).toBe(code);
  expect(new Set(lines!.flat().map(token => token.variants.dark.color)).size).toBeGreaterThan(1);
});
