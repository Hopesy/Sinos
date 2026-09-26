import { ChevronDown, CircleDashed, Layers, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ChatMessage } from '../lib/chat-transcript';
import { ConversationTool } from './ConversationTool';

export function ConversationToolGroup({ messages, cwd, activeIds, active }: { messages: ChatMessage[]; cwd: string; activeIds: Set<string>; active: boolean }) {
  const running = messages.filter(message => message.toolStatus === 'running' && active && activeIds.has(message.id));
  const isRunning = running.length > 0;
  const [disclosure, setDisclosure] = useState({ running: isRunning, expanded: isRunning });
  if (disclosure.running !== isRunning) {
    setDisclosure({ running: isRunning, expanded: isRunning || disclosure.expanded });
  }
  const failed = messages.filter(message => message.toolStatus === 'failed');
  const done = messages.filter(message => message.toolStatus === 'done').length;
  const body = messages.map(message => <ConversationTool key={message.id} message={message} cwd={cwd} active={active && activeIds.has(message.id)} />);
  if (messages.length === 1) return body;
  const labels = [...new Set(messages.map(message => {
    const name = (message.toolName || '').toLowerCase();
    return /read|view_file/.test(name) ? '读取' : /grep|glob|search/.test(name) ? '搜索' : /edit|write|patch/.test(name) ? '修改' : /bash|shell|exec|command/.test(name) ? '命令' : '工具';
  }))];
  return <details open={disclosure.expanded} onToggle={event => { const expanded = event.currentTarget.open; setDisclosure(current => ({ ...current, expanded })); }} className={`tool-group ${failed.length ? 'has-failure' : ''}`}>
    <summary>{running.length ? <CircleDashed size={16} className="spin" /> : failed.length ? <TriangleAlert size={16} /> : <Layers size={16} />}<span className="tool-group-title">{running.length ? '正在处理' : '执行过程'}<small>{labels.join(' · ')} · {messages.length} 项操作</small></span><span className="tool-group-state">{failed.length ? `${failed.length} 项失败` : running.length ? `${done}/${messages.length}` : done === messages.length ? '已完成' : `${done}/${messages.length} 完成`}</span><ChevronDown size={14} /></summary>
    <div className="tool-group-items">{body}</div>
  </details>;
}
