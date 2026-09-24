import { ChevronDown } from 'lucide-react';
import type { TerminalStatus } from './claudeChrome';

export function ConversationStatus({ status, cwd }: { status: TerminalStatus; cwd: string }) {
  return <details className="conversation-status" aria-label="会话状态">
    <summary><strong>{status.model || '会话状态'}</strong><span>{status.lines[0]}</span><ChevronDown size={14} /></summary>
    <div className="conversation-status-details">
      {cwd && <p><span>目录</span><code>{cwd}</code></p>}
      {status.lines.map(line => <p key={line}>{line}</p>)}
    </div>
  </details>;
}
