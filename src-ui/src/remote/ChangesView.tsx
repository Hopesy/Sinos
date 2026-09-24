import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTwoFilesPatch } from 'diff';
import { RemoteClient, errorMessage } from './client';
import { Icon } from './Icons';
import type { Changes, FileDiff } from './types';

export function ChangesView({ client, sessionId, active, onPrompt }: { client: RemoteClient; sessionId: string; active: boolean; onPrompt: (text: string) => void }) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current; setBusy(true); setError('');
    try { const result = await client.changes(sessionId); if (generation.current === request) setChanges(result); }
    catch (cause) { if (generation.current === request) setError(errorMessage(cause)); }
    finally { if (generation.current === request) setBusy(false); }
  }, [client, sessionId]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { if (active) void refresh(); return invalidate; }, [refresh, active, invalidate]);
  const openDiff = async (path: string) => {
    const request = ++generation.current; setBusy(true); setError('');
    try { const result = await client.diff(sessionId, path); if (generation.current === request) setDiff(result); }
    catch (cause) { if (generation.current === request) setError(errorMessage(cause)); }
    finally { if (generation.current === request) setBusy(false); }
  };
  const patch = useMemo(() => diff ? createTwoFilesPatch(`a/${diff.path}`, `b/${diff.path}`, diff.before, diff.after, '', '', { context: 3, timeout: 1000 }) : '', [diff]);
  const lines = patch?.split('\n') ?? [];
  const files = changes?.files || [];
  return <div className="page-panel mobile-changes">
    {diff ? <>
      <div className="page-toolbar"><button className="icon-button" aria-label="返回变更列表" onClick={() => setDiff(null)}><Icon name="back" /></button><div className="page-toolbar-title"><strong>{diff.path.split('/').pop()}</strong><small>{diff.path}</small></div><button className="icon-button" aria-label="让 AI 解释此变更" onClick={() => onPrompt(`请解释 @${diff.path} 中尚未提交的修改，检查潜在问题并给出建议。`)}><Icon name="spark" /></button></div>
      <div className="file-meta"><span>最近一次提交 → 当前文件</span><span>统一差异</span></div>
      <div className="mobile-diff">{patch === undefined ? <p className="empty-inline">差异较大，请在电脑端查看完整对比。</p> : diff.before === diff.after ? <p className="empty-inline">文件内容没有变化，可能仅修改了权限。</p> : <pre>{lines.slice(0, 3000).map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line || ' '}{'\n'}</span>)}</pre>}{lines.length > 3000 && <p className="empty-inline">仅展示前 3,000 行，请在电脑端查看完整差异。</p>}</div>
    </> : <>
      <div className="page-heading"><div><span className="eyebrow">CODE REVIEW</span><h2>审查变更</h2></div><button className="icon-button" aria-label="刷新变更" onClick={() => void refresh()} disabled={busy}><Icon name="refresh" /></button></div>
      {error && <div className="inline-error" role="alert">{error}<button onClick={() => void refresh()}>重试</button></div>}
      {changes?.state === 'ok' && <div className="change-summary"><div><Icon name="changes" size={17} /><strong>{changes.branch}</strong><span>{files.length} 个文件</span></div><div><span className="text-success">+{files.reduce((sum, file) => sum + file.added, 0)}</span><span className="text-danger">−{files.reduce((sum, file) => sum + file.deleted, 0)}</span></div></div>}
      <div className="file-list">{busy && !changes ? <div className="loading-state">正在读取变更…</div> : files.length ? files.map((file) => <button key={file.path} disabled={busy} className="file-row change-row" onClick={() => void openDiff(file.path)}><span className={`change-status status-${file.status}`}>{file.status === '?' ? 'A' : file.status}</span><span><strong>{file.path.split('/').pop()}</strong><small>{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '项目根目录'}</small></span><div className="change-count"><span className="text-success">+{file.added}</span><span className="text-danger">−{file.deleted}</span></div><Icon name="chevron" size={15} /></button>) : <div className="empty-feature"><span className="empty-feature-icon"><Icon name={changes?.state === 'ok' ? 'check' : 'changes'} size={28} /></span><h3>{changes?.state === 'no_git' ? '电脑尚未安装 Git' : changes?.state === 'not_repo' ? '这个项目还没有 Git 仓库' : '工作区很干净'}</h3><p>{changes?.state === 'ok' ? 'AI 或你修改的文件会出现在这里。' : '初始化仓库后，就能在手机上审查代码变更。'}</p></div>}</div>
      {files.length > 0 && <div className="panel-bottom-action"><button className="primary-button" onClick={() => onPrompt('请审查当前项目所有尚未提交的变更，检查潜在缺陷、边界情况和测试覆盖，先给出审查结论。')}><Icon name="spark" size={18} /> 让 AI 审查这些变更</button><p className="muted">任务会填入输入框，由你确认后发送</p></div>}
    </>}
  </div>;
}
