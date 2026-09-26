import { Children, isValidElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clipboardWrite } from '../lib/clipboard';
import type { ThemedTokenWithVariants } from 'shiki/core';
import { codeLanguage, codeLanguages } from './codeLanguage';

function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : typeof child === 'string' || typeof child === 'number' ? String(child) : '').join('');
}

export function ConversationCode({ code, language: hint = 'text' }: { code: string; language?: string }) {
  const [chosen, setChosen] = useState('auto');
  const language = chosen === 'auto' ? codeLanguage(code, hint) : chosen;
  const hasContent = /[^\s\p{Cf}\u2800]/u.test(code);
  const [highlight, setHighlight] = useState<{ code: string; language: string; lines: ThemedTokenWithVariants[][] } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const latest = useRef({ code, language }); latest.current = { code, language };
  const work = useRef<{ timer?: ReturnType<typeof setTimeout>; active: boolean; mounted: boolean }>({ active: false, mounted: true });
  useEffect(() => {
    const state = work.current;
    state.mounted = true;
    return () => { state.mounted = false; clearTimeout(state.timer); state.active = false; };
  }, []);
  useEffect(() => {
    const state = work.current;
    if (!hasContent) return;
    function schedule() {
      if (state.active || !state.mounted) return;
      state.active = true;
      state.timer = setTimeout(() => {
        const snapshot = latest.current;
        void import('./highlightCode').then(module => module.highlightCode(snapshot.code, snapshot.language === 'text' ? 'plain' : snapshot.language)).then(lines => {
          if (state.mounted && lines) setHighlight({ ...snapshot, lines });
        }).catch(() => {}).finally(() => {
          state.active = false;
          if (snapshot.code !== latest.current.code || snapshot.language !== latest.current.language) schedule();
        });
      }, 100);
    }
    schedule();
  }, [code, language, hasContent]);
  useEffect(() => { if (copied === null) return; const timer = setTimeout(() => setCopied(null), 1800); return () => clearTimeout(timer); }, [copied]);
  // Keep only complete, unchanged highlighted lines while the next chunk is
  // being tokenized. Never turn the entire block back into plain text.
  const prefix = highlight && highlight.language === language && code.startsWith(highlight.code)
    ? highlight.code === code ? code.length : highlight.code.lastIndexOf('\n') + 1 : 0;
  const lines = prefix && highlight ? highlight.lines.slice(0, highlight.code === code ? undefined : highlight.code.slice(0, prefix).split('\n').length - 1) : null;
  async function copy() {
    setCopyError(false); setCopied(null);
    try { await clipboardWrite(code, { throwOnError: true }); setCopied(code); }
    catch { setCopyError(true); }
  }
  if (!hasContent) return null;
  return <div className="conversation-code">
    <div className="code-heading"><select aria-label="代码语言" value={chosen} onChange={event => setChosen(event.target.value)}><option value="auto">{language} · 自动</option>{codeLanguages.map(lang => <option key={lang} value={lang}>{lang === 'text' ? '纯文本' : lang}</option>)}</select><button type="button" onClick={() => void copy()} aria-label="复制代码">{copied === code ? <Check size={14} /> : <Copy size={14} />}{copied === code ? '已复制' : '复制'}</button></div>
    {copyError && <p className="code-copy-error" role="status">复制失败，请长按代码选择并复制。</p>}
    <pre tabIndex={0} aria-label={`${language} 代码`}><code>{lines ? <>{lines.map((line, index) => <span className="code-line" key={index}>{line.map((token, part) => <span key={part} style={{ '--code-light': token.variants.light.color, '--code-dark': token.variants.dark.color } as CSSProperties}>{token.content}</span>)}{index < lines.length - 1 || prefix < code.length ? '\n' : ''}</span>)}{code.slice(prefix)}</> : code}</code></pre>
  </div>;
}

const components: Components = {
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  pre: ({ children }) => {
    const child = Children.toArray(children)[0];
    const language = isValidElement<{ className?: string }>(child) ? /language-([^\s]+)/.exec(child.props.className || '')?.[1] : undefined;
    return <ConversationCode code={textOf(children).replace(/\n$/, '')} language={language} />;
  },
};
export function ConversationMarkdown({ text, terminal = false }: { text: string; terminal?: boolean }) {
  return <div className={`chat-markdown${terminal ? ' terminal-projection' : ''}`}><Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown></div>;
}
