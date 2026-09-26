import type { HighlighterCore, ThemedTokenWithVariants } from 'shiki/core';
import { codeLanguage } from './codeLanguage';

// Small, lazy grammar set; the JavaScript engine also works with the phone's
// strict CSP, without adding unsafe-eval or WebAssembly permissions.
const grammars = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'), jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'), css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'), python: () => import('shiki/langs/python.mjs'),
  bash: () => import('shiki/langs/bash.mjs'), rust: () => import('shiki/langs/rust.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'), sql: () => import('shiki/langs/sql.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  c: () => import('shiki/langs/c.mjs'), cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'), java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'), swift: () => import('shiki/langs/swift.mjs'),
  go: () => import('shiki/langs/go.mjs'), php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'), lua: () => import('shiki/langs/lua.mjs'),
  dart: () => import('shiki/langs/dart.mjs'), vue: () => import('shiki/langs/vue.mjs'),
  toml: () => import('shiki/langs/toml.mjs'), dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  diff: () => import('shiki/langs/diff.mjs'), markdown: () => import('shiki/langs/markdown.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
};
let engine: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();

export async function highlightCode(code: string, language: string): Promise<ThemedTokenWithVariants[][] | null> {
  const lang = language === 'plain' ? 'text' : codeLanguage(code, language);
  const rows = code.split('\n');
  // Minified/single-line payloads can make grammar regexes monopolize the
  // phone's main thread. Preserve the source but skip those pathological lines.
  if (!(lang in grammars) || code.length > 120000 || rows.length > 2000 || rows.some(line => line.length > 2000)) return null;
  try {
    engine ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')])
      .then(([core, js, light, dark]) => core.createHighlighterCore({ engine: js.createJavaScriptRegexEngine(), themes: [light.default, dark.default], langs: [] }))
      .catch(error => { engine = undefined; throw error; });
    const highlighter = await engine;
    if (!loading.has(lang)) loading.set(lang, grammars[lang as keyof typeof grammars]().then(grammar => highlighter.loadLanguage(grammar.default)).catch(error => { loading.delete(lang); throw error; }));
    await loading.get(lang);
    // Leave room for the first grammar compilation on slower phones. An
    // aggressively short limit truncates coloring halfway through a line.
    return highlighter.codeToTokensWithThemes(code, { lang, themes: { light: 'github-light', dark: 'github-dark' }, tokenizeTimeLimit: 500 });
  } catch { return null; }
}
