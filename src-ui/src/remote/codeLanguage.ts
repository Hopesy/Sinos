export const codeLanguages = ['text', 'javascript', 'typescript', 'tsx', 'jsx', 'json', 'css', 'html', 'xml', 'python', 'bash', 'powershell', 'rust', 'yaml', 'sql', 'c', 'cpp', 'csharp', 'java', 'kotlin', 'swift', 'go', 'php', 'ruby', 'lua', 'dart', 'vue', 'toml', 'dockerfile', 'diff', 'markdown'] as const;
const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', zsh: 'bash', shell: 'bash', shellscript: 'bash', yml: 'yaml', rs: 'rust', ps1: 'powershell', ps: 'powershell', 'c++': 'cpp', cc: 'cpp', 'c#': 'csharp', cs: 'csharp', kt: 'kotlin', golang: 'go', md: 'markdown', rb: 'ruby', plaintext: 'text', txt: 'text' };
export function codeLanguage(code: string, hint = ''): string {
  const label = hint.trim().toLowerCase().replace(/^language-/, '').split(/[\s{]/)[0];
  const explicit = aliases[label] || label;
  if (explicit && explicit !== 'text' && codeLanguages.includes(explicit as typeof codeLanguages[number])) return explicit;
  if (explicit && explicit !== 'text') return 'text';
  const sample = code.slice(0, 12000);
  if (/^\s*(?:diff --git |@@ [-+]|--- a\/|\+\+\+ b\/)/m.test(sample)) return 'diff';
  if (/^\s*#include\s*[<"]|\bstd::|\bint main\s*\(/m.test(sample)) return /std::|iostream|vector|cout/.test(sample) ? 'cpp' : 'c';
  if (/\busing System\b|\bnamespace \w+\s*\{|\bConsole\.Write/.test(sample)) return 'csharp';
  if (/\bpublic static void main\b|\bSystem\.out\.|^\s*import java\./m.test(sample)) return 'java';
  if (/^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+|^\s*use\s+\w+::/m.test(sample)) return 'rust';
  if (/^\s*package\s+\w+\s*$|^\s*func\s+\w+\(/m.test(sample)) return 'go';
  if (/^\s*(?:async\s+)?def\s+\w+\(|^\s*from\s+[\w.]+\s+import\s|^\s*if __name__\s*==/m.test(sample)) return 'python';
  if (/^\s*(?:export\s+)?(?:interface|type)\s+\w+\s*[={<]|\b(?:const|let)\s+\w+\s*:\s*[\w[<{]/m.test(sample)) return 'typescript';
  if (/^\s*(?:export\s+)?(?:async\s+)?function\s|\b(?:const|let)\s+\w+\s*=|\bconsole\.log\(/m.test(sample)) return 'javascript';
  if (/^\s*(?:<!doctype html|<html|<div|<body|<head|<script|<style)\b/i.test(sample)) return 'html';
  if (/^\s*<\?xml\b/.test(sample)) return 'xml';
  if (/^\s*<\?php\b/.test(sample)) return 'php';
  if (/^\s*(?:FROM\s+\S+|RUN\s+\S+|WORKDIR\s+\/)/m.test(sample)) return 'dockerfile';
  if (/^\s*(?:SELECT\s+.+\s+FROM|CREATE\s+TABLE|INSERT\s+INTO|UPDATE\s+\S+\s+SET)\b/im.test(sample)) return 'sql';
  if (/^\s*(?:Get-|Set-|New-|Remove-|Write-)(?:Item|Content|ChildItem|Host|Output)|^\s*\$\w+\s*=/m.test(sample)) return 'powershell';
  if (/^#!.*\b(?:ba|z)?sh\b|^\s*(?:npm|pnpm|yarn|git|pip|cargo|curl|sudo|cd|mkdir)\s+\S/m.test(sample)) return 'bash';
  if (/^\s*[{[]/.test(sample)) { try { JSON.parse(code); return 'json'; } catch { if (/^\s*\{\s*"[^"\n]+"\s*:/.test(sample)) return 'json'; } }
  return 'text';
}
