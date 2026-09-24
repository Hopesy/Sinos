import { useState } from 'react';
import { CircleHelp } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationQuestion as Question } from './conversationProjection';

export function ConversationQuestion({ question, disabled, unsupported, answering, answered, disconnected, onAnswer }: {
  question: Question; disabled: boolean; unsupported: boolean; answering: boolean; answered: boolean; disconnected: boolean;
  onAnswer: (answer: number | number[] | string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(() => question.choices.flatMap((choice, index) => choice.checked ? [index] : []));
  const blocked = disabled || unsupported || answering || answered;
  const submit = (value: number | number[] | string) => { void onAnswer(value).catch(() => {}); };
  return <section className="conversation-question" aria-label={question.kind === 'text' ? '需要你的回答' : '需要你的确认'}>
    <div className="question-heading"><CircleHelp size={18} /><strong>{question.kind === 'text' ? '需要你的回答' : question.kind === 'multi' ? '请选择，可多选' : '需要你的确认'}</strong></div>
    <div className="question-content chat-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ a: props => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{question.text}</Markdown></div>
      {question.kind === 'text' ? <form className="question-answer" onSubmit={event => { event.preventDefault(); submit(text); }}><textarea rows={2} aria-label="你的回答" placeholder="写下你的回答…" value={text} disabled={blocked} onChange={event => setText(event.target.value)} maxLength={4000} /><button disabled={blocked || !text.trim()} type="submit">回复</button></form> : question.kind === 'multi' ? <div className="question-multi">{question.choices.map((choice, index) => <label key={index}><input type="checkbox" checked={selected.includes(index)} disabled={blocked} onChange={event => setSelected(value => event.target.checked ? [...value, index] : value.filter(item => item !== index))} /><span>{choice.label}</span></label>)}<button disabled={blocked} onClick={() => submit(selected)}>确认选择{selected.length ? ` · ${selected.length} 项` : ''}</button></div> : <div className="question-choices">{question.choices.map((choice, index) => <button key={index} disabled={blocked} aria-current={question.cursor === index ? 'true' : undefined} onClick={() => submit(index)}><span>{choice.label}</span>{question.cursor === index && <small>当前选中</small>}</button>)}</div>}
    {question.kind !== 'multi' && question.cursor !== undefined && <p>点击选项即可确认</p>}
    {unsupported ? <p role="status">电脑端需更新后才能在这里回答。</p> : answering ? <p role="status">正在提交你的选择…</p> : answered ? <p role="status">已回复，等待继续…</p> : disconnected && <p role="status">连接恢复后即可回答</p>}
  </section>;
}
