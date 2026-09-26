import type { TerminalStatus } from './claudeChrome';
import { contextUsage } from './contextUsage';

export function ConversationStatus({ status, cwd, title }: { status: TerminalStatus; cwd: string; title?: string }) {
  const { used, lines } = contextUsage(status);
  const directory = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
  const caption = title?.trim() || lines.find(line => line !== cwd && line !== status.model);
  return <div className="conversation-status" role="group" aria-label="会话状态">
    <div className="conversation-status-context">
      <strong className="status-model" title={status.model}>{status.model || '会话状态'}</strong>
      {cwd && <code className="status-directory" title={cwd} aria-label={cwd}>{directory}</code>}
    </div>
    <div className="conversation-status-session">
      {caption && <span className="status-title" title={caption}>{caption}</span>}
      {used !== undefined && <svg className={`context-ring${used >= 90 ? ' is-full' : ''}`} viewBox="0 0 24 24" width="22" height="22" role="meter" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-valuetext={`已用 ${used}%`}>
        <title>{`上下文已用 ${used}%`}</title>
        <circle className="context-ring-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.5" />
        <circle className="context-ring-value" cx="12" cy="12" r="9" fill="none" strokeWidth="2.5" pathLength="100" strokeDasharray={`${used} 100`} transform="rotate(-90 12 12)" />
      </svg>}
    </div>
  </div>;
}
