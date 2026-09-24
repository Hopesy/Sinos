import { Children, isValidElement, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clipboardWrite } from '../lib/clipboard';
import type { ThemedTokenWithVariants } from 'shiki/core';

function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : typeof child === 'string' || typeof child === 'number' ? String(child) : '').join('');
}

export function ConversationCode({ code, language = 'text' }: { code: string; language?: string }) {
  const [highlight, setHighlight] = useState<{ code: string; language: string; lines: ThemedTokenWithVariants[][] } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Debounce streamed partial code, and keep its plain text visible throughout.
    const timer = setTimeout(() => { void import('./highlightCode').then(module => module.highlightCode(code, language)).then(lines => { if (!cancelled && lines) setHighlight({ code, language, lines }); }).catch(() => {}); }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, language]);
  useEffect(() => { if (copied === null) return; const timer = setTimeout(() => setCopied(null), 1800); return () => clearTimeout(timer); }, [copied]);
  const lines = highlight?.code === code && highlight.language === language ? highlight.lines : null;
  async function copy() {
    setCopyError(false);
    try { await clipboardWrite(code, { throwOnError: true }); setCopied(code); }
    catch { setCopyError(true); }
  }
  return <div className="conversation-code">
    <div className="code-heading"><span>{language}</span><button type="button" onClick={() => void copy()} aria-label="复制代码">{copied === code ? <Check size={14} /> : <Copy size={14} />}{copied === code ? '已复制' : '复制'}</button></div>
    {copyError && <p className="code-copy-error" role="status">复制失败，请长按代码选择并复制。</p>}
    <pre tabIndex={0} aria-label={`${language} 代码`}><code>{lines ? lines.map((line, index) => <span className="code-line" key={index}>{line.map((token, part) => <span key={part} style={{ '--code-light': token.variants.light.color, '--code-dark': token.variants.dark.color } as CSSProperties}>{token.content}</span>)}{index < lines.length - 1 ? '\n' : ''}</span>) : code}</code></pre>
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
export function ConversationMarkdown({ text }: { text: string }) {
  return <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown></div>;
}
