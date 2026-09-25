import { CircleCheck, CircleDashed, Circle } from 'lucide-react';
import { ConversationDiff } from './ConversationDiff';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function ConversationPlan({ plan, explanation }: { plan: unknown; explanation?: unknown }) {
  if (!Array.isArray(plan)) return null;
  return <div className="conversation-plan">{typeof explanation === 'string' && <p>{explanation}</p>}<ol aria-label="执行计划">{plan.filter(object).map((step, index) => {
    const state = String(step.status), Icon = state === 'completed' ? CircleCheck : state === 'in_progress' ? CircleDashed : Circle;
    return <li key={index} data-state={state}><Icon size={15} /><span>{String(step.step ?? '')}</span><small>{state === 'completed' ? '已完成' : state === 'in_progress' ? '进行中' : '待处理'}</small></li>;
  })}</ol></div>;
}

function UnifiedDiff({ text }: { text: string }) {
  return <pre className="conversation-patch" tabIndex={0} aria-label="代码修改差异"><code>{text.split('\n').map((line, index) => <span className={`diff-line ${line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : ''}`} key={index}>{line}{'\n'}</span>)}</code></pre>;
}

export function ConversationChanges({ changes, patch }: { changes?: Record<string, unknown>; patch: string }) {
  if (!changes) return /^\*\*\* Begin Patch\r?\n/.test(patch) ? <UnifiedDiff text={patch} /> : null;
  return <div className="conversation-changes">{Object.entries(changes).filter(([, change]) => object(change)).map(([path, raw]) => {
    const change = raw as Record<string, unknown>;
    return <section key={path}><div className="tool-detail-heading"><span>{change.type === 'add' ? '新增' : change.type === 'delete' ? '删除' : '修改'}</span><code>{path}{typeof change.move_path === 'string' ? ` → ${change.move_path}` : ''}</code></div>
      {typeof change.unified_diff === 'string' ? <UnifiedDiff text={change.unified_diff} /> : typeof change.content === 'string' ? <ConversationDiff before={change.type === 'delete' ? change.content : ''} after={change.type === 'delete' ? '' : change.content} /> : <pre>{JSON.stringify(change, null, 2)}</pre>}
    </section>;
  })}</div>;
}
