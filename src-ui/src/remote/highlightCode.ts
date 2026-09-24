import type { HighlighterCore, ThemedTokenWithVariants } from 'shiki/core';

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
};
const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', shellscript: 'bash', yml: 'yaml', rs: 'rust', ps1: 'powershell' };
let engine: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();

export async function highlightCode(code: string, language: string): Promise<ThemedTokenWithVariants[][] | null> {
  const lang = aliases[language.toLowerCase()] || language.toLowerCase();
  if (!(lang in grammars) || code.length > 24000 || code.split('\n').length > 500) return null;
  try {
    engine ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')])
      .then(([core, js, light, dark]) => core.createHighlighterCore({ engine: js.createJavaScriptRegexEngine(), themes: [light.default, dark.default], langs: [] }))
      .catch(error => { engine = undefined; throw error; });
    const highlighter = await engine;
    if (!loading.has(lang)) loading.set(lang, grammars[lang as keyof typeof grammars]().then(grammar => highlighter.loadLanguage(grammar.default)).catch(error => { loading.delete(lang); throw error; }));
    await loading.get(lang);
    return highlighter.codeToTokensWithThemes(code, { lang, themes: { light: 'github-light', dark: 'github-dark' } });
  } catch { return null; }
}
