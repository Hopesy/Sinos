import { ChevronDown, CircleCheck, CircleDashed, FileCode, FileSearch, Search, SquareTerminal, X, Wrench } from 'lucide-react';
import type { ChatMessage } from '../lib/chat-transcript';
import { ConversationDiff } from './ConversationDiff';

function parameters(content: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(content); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}
function value(args: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (typeof args[key] === 'string') return args[key] as string;
  return '';
}
function relativePath(path: string, cwd: string) {
  const normalized = path.replace(/\\/g, '/'), base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const windows = /^[A-Za-z]:\//.test(base);
  return (windows ? normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`) : normalized.startsWith(`${base}/`)) ? normalized.slice(base.length + 1) : path;
}

export function ConversationTool({ message, cwd, active }: { message: ChatMessage; cwd: string; active: boolean }) {
  const args = parameters(message.content);
  const name = (message.toolName || '').split('.').at(-1)?.toLowerCase() || '';
  const path = value(args, 'file_path', 'path', 'target_file');
  const command = value(args, 'command', 'cmd', 'shell_command');
  const query = value(args, 'pattern', 'query', 'search_query');
  const reasoning = message.role === 'reasoning';
  const edit = /^(edit|multiedit|write|write_file|apply_patch)$/.test(name);
  const read = /^(read|read_file|view_file)$/.test(name);
  const search = /^(grep|glob|search|websearch|web_search)$/.test(name);
  const shell = Boolean(command) || /^(bash|shell|exec|exec_command|run_command)$/.test(name);
  const label = reasoning ? '思考过程' : edit ? '修改文件' : read ? '读取文件' : search ? '搜索' : shell ? '运行命令' : message.toolName || '工具调用';
  const summary = reasoning ? '' : path ? relativePath(path, cwd) : command || query || '';
  const before = value(args, 'old_string', 'old_text'), after = value(args, 'new_string', 'new_text');
  const content = command || (read ? [args.offset != null && `起始行：${args.offset}`, args.limit != null && `行数：${args.limit}`].filter(Boolean).join('\n') : search ? [query, path].filter(Boolean).join('\n') : value(args, 'content') || message.content);
  const failed = message.toolStatus === 'failed';
  // Missing results in an old history page do not mean the tool is still running.
  const running = !reasoning && message.toolStatus === 'running' && active;
  const unresolved = !reasoning && message.toolStatus === 'running' && !active;
  const Icon = reasoning || running || unresolved ? CircleDashed : failed ? X : CircleCheck;
  const KindIcon = edit ? FileCode : read ? FileSearch : search ? Search : shell ? SquareTerminal : reasoning ? CircleDashed : Wrench;
  return <details className={`chat-tool ${failed ? 'tool-failed' : ''} ${reasoning ? 'tool-reasoning' : ''}`} data-tool-kind={edit ? 'edit' : read ? 'read' : search ? 'search' : shell ? 'shell' : 'other'}>
    <summary><span className="tool-kind-icon"><KindIcon size={16} /></span><span className="tool-description"><span>{label}</span>{summary && <code title={summary}>{summary}</code>}</span><span className={`tool-state ${running ? 'is-running' : failed ? 'is-failed' : unresolved ? '' : 'is-done'}`}><Icon size={12} className={running ? 'spin' : ''} />{running ? '执行中' : failed ? '失败' : unresolved ? '未收到结果' : reasoning ? '' : '完成'}</span><ChevronDown size={13} /></summary>
    <div className="tool-body">
      {KindIcon && <div className="tool-detail-heading"><KindIcon size={14} /><span>{label}</span>{path && <code>{path}</code>}</div>}
      {edit && (before || after) ? <ConversationDiff before={before} after={after} /> : content && <pre>{content}</pre>}
      {message.output && <div className="tool-result"><span>执行结果</span><pre>{message.output}</pre></div>}
    </div>
  </details>;
}
