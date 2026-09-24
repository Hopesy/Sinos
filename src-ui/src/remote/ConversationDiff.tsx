import { useMemo } from 'react';
import { diffLines } from 'diff';

export function ConversationDiff({ before, after }: { before: string; after: string }) {
  const changes = useMemo(() => before.length + after.length <= 100000 ? diffLines(before, after, { timeout: 25, maxEditLength: 1500 }) : undefined, [before, after]);
  if (!changes) return <div className="tool-edit"><span>修改前</span><pre className="tool-removed">{before || '（空）'}</pre><span>修改后</span><pre className="tool-added">{after || '（空）'}</pre></div>;
  const added = changes.reduce((n, part) => n + (part.added ? part.count : 0), 0);
  const removed = changes.reduce((n, part) => n + (part.removed ? part.count : 0), 0);
  return <div className="conversation-diff">
    <div className="diff-heading"><span>修改片段</span><span className="diff-added">+{added}</span><span className="diff-removed">−{removed}</span></div>
    <pre tabIndex={0} aria-label="代码修改差异"><code>{changes.flatMap((part, partIndex) => part.value.replace(/\n$/, '').split('\n').map((line, index) => <span className={`diff-line ${part.added ? 'added' : part.removed ? 'removed' : ''}`} key={`${partIndex}-${index}`}><span className="diff-sign" aria-hidden="true">{part.added ? '+' : part.removed ? '−' : ' '}</span><span>{line || '\u00a0'}</span>{'\n'}</span>))}</code></pre>
  </div>;
}
