import { useCallback, useEffect, useRef, useState } from 'react';
import { RemoteClient, RemoteError, errorMessage, storageRead, storageWrite } from './client';
import { Icon } from './Icons';
import { Sheet } from './Sheet';
import type { FileEntry, FileSnapshot } from './types';

export function FilesView({ client, sessionId, online, onAttach }: { client: RemoteClient; sessionId: string; online: boolean; onAttach: (path: string) => void }) {
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [path, setPath] = useState('');
  const [file, setFile] = useState<FileSnapshot | null>(null);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const generation = useRef(0);
  const dirty = file !== null && content !== file.content;
  const draftKey = `file-draft-${sessionId}-${path}`;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError('');
    try { const result = await client.directory(sessionId, directory); if (generation.current === request) { setEntries(result.entries); setTruncated(result.truncated); } }
    catch (cause) { if (generation.current === request) setError(errorMessage(cause)); }
    finally { if (generation.current === request) setLoading(false); }
  }, [client, sessionId, directory]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { void refresh(); return invalidate; }, [refresh, invalidate]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const open = async (nextPath: string, discard = false) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const snapshot = await client.file(sessionId, nextPath);
      const stored = storageRead(`file-draft-${sessionId}-${nextPath}`);
      let recovered: { content: string; file: FileSnapshot } | null = null;
      try { recovered = stored && !discard ? JSON.parse(stored) : null; } catch { /* Ignore an invalid local draft. */ }
      setPath(nextPath); setFile(recovered?.file || snapshot); setContent(recovered?.content ?? snapshot.content); setEditing(Boolean(recovered));
      setConflict(Boolean(recovered && recovered.file.revision !== snapshot.revision));
      if (recovered) setNotice('已恢复上次未保存的草稿');
      if (discard) storageWrite(`file-draft-${sessionId}-${nextPath}`, '');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!file || !dirty || busy) return;
    setBusy(true); setError('');
    try {
      const saved = await client.save(sessionId, path, content, file);
      setFile({ ...file, ...saved, content }); setConflict(false); setNotice('已保存到电脑'); storageWrite(draftKey, '');
    } catch (cause) { setError(errorMessage(cause)); if (cause instanceof RemoteError && cause.status === 409) setConflict(true); }
    finally { setBusy(false); }
  };
  const change = (value: string) => { setContent(value); setNotice(''); storageWrite(draftKey, value === file?.content ? '' : JSON.stringify({ content: value, file })); };
  return <div className="mobile-files page-panel">
    {path && file ? <>
      <div className="page-toolbar"><button className="icon-button" aria-label="返回文件列表" onClick={() => { setPath(''); setFile(null); setError(''); setNotice(''); }} disabled={busy}><Icon name="back" /></button><div className="page-toolbar-title"><strong>{path.split('/').pop()}{dirty && <span className="unsaved-dot" />}</strong><small>{path}</small></div><button className="icon-button" aria-label="引用文件到任务" onClick={() => onAttach(path)}><Icon name="link" /></button>{editing ? <button className="small-primary" disabled={!online || !dirty || busy || conflict} onClick={() => void save()}><Icon name="save" size={15} />{busy ? '保存中' : '保存'}</button> : <button className="icon-button" aria-label="编辑文件" onClick={() => setEditing(true)}><Icon name="edit" /></button>}</div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {conflict && <div className="conflict-banner">电脑端有新的版本，草稿已保留。<button onClick={() => setConfirmReload(true)}>重新载入</button></div>}
      <div className="file-meta"><span>{editing ? '编辑中' : '只读预览'} · UTF-8 · {file.line_ending.toUpperCase()}</span><span role="status">{notice || (dirty ? '未保存 · 本机草稿' : `${Math.max(1, content.split('\n').length)} 行`)}</span></div>
      {editing ? <textarea className="mobile-code-editor" aria-label="文件内容" value={content} onChange={(e) => change(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy} onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); const t = e.currentTarget, start = t.selectionStart, end = t.selectionEnd; change(content.slice(0, start) + '  ' + content.slice(end)); requestAnimationFrame(() => t.setSelectionRange(start + 2, start + 2)); } }} /> : <div className="mobile-code-preview"><pre>{content || '（空文件）'}</pre></div>}
      {confirmReload && <Sheet title="重新载入文件？" onClose={() => setConfirmReload(false)}><p className="sheet-description">这会放弃当前文件的手机草稿，并读取电脑端的最新版本。</p><div className="sheet-actions"><button className="secondary-button" onClick={() => setConfirmReload(false)}>保留草稿</button><button className="danger-button" onClick={() => { setConfirmReload(false); void open(path, true); }}>放弃并载入</button></div></Sheet>}
    </> : <>
      <div className="page-heading"><div><span className="eyebrow">PROJECT FILES</span><h2>项目文件</h2></div><button className="icon-button" aria-label="刷新文件" onClick={() => void refresh()} disabled={loading}><Icon name="refresh" /></button></div>
      <div className="file-breadcrumb"><button onClick={() => { setDirectory(''); setFilter(''); }}><Icon name="folder" size={16} /> 项目</button>{directory.split('/').filter(Boolean).map((part, index, parts) => <span key={index}><Icon name="chevron" size={13} /><button onClick={() => { setDirectory(parts.slice(0, index + 1).join('/')); setFilter(''); }}>{part}</button></span>)}</div>
      <label className="mobile-search"><Icon name="search" size={18} /><input aria-label="筛选当前目录" placeholder="筛选当前目录…" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
      {error && <div className="inline-error" role="alert">{error}<button onClick={() => void refresh()}>重试</button></div>}
      <div className="file-list">{loading ? <div className="loading-state">正在读取项目文件…</div> : <>
        {directory && <button className="file-row" onClick={() => { setDirectory(directory.split('/').slice(0, -1).join('/')); setFilter(''); }}><Icon name="back" size={18} /><span>上一级目录</span></button>}
        {entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())).map((entry) => <button key={entry.path} className="file-row" disabled={busy} onClick={() => { if (entry.is_dir) { setDirectory(entry.path); setFilter(''); } else void open(entry.path); }}><span className={`file-icon ${entry.is_dir ? 'is-folder' : ''}`}><Icon name={entry.is_dir ? 'folder' : 'file'} size={19} /></span><span>{entry.name}</span>{entry.is_dir ? <Icon name="chevron" size={15} /> : <small>{entry.size < 1024 ? `${entry.size} B` : `${(entry.size / 1024).toFixed(1)} KB`}</small>}</button>)}
        {!entries.some((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())) && <div className="empty-inline">{filter ? '没有匹配的文件' : '这个目录还是空的'}</div>}
        {truncated && <p className="empty-inline">仅显示前 1,000 项，请在电脑端查看完整目录。</p>}
      </>}</div><div className="panel-footnote">浏览、编辑，或将文件引用到 AI 任务中</div>
    </>}
  </div>;
}
