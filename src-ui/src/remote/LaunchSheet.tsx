import { useState } from 'react';
import { RemoteClient, errorMessage, projectName } from './client';
import { Sheet } from './Sheet';
import { Icon } from './Icons';
import type { RemoteSession, RemoteTool } from './types';
export function LaunchSheet({ client, tools, sessions, cwd, onClose, onLaunched }: { client: RemoteClient; tools: RemoteTool[]; sessions: RemoteSession[]; cwd: string; onClose: () => void; onLaunched: (id: string) => void }) {
  const [tool, setTool] = useState(tools[0]?.id || '');
  const [folder, setFolder] = useState(cwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = tools.find((item) => item.id === tool) || tools[0];
  const launch = async () => {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try { const result = await client.launch(selected.id, folder.trim()); onLaunched(result.session_id); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <Sheet title="开启新会话" onClose={() => { if (!busy) onClose(); }}>
    <p className="sheet-description">选一个 AI 工具，继续你的项目。</p>
    <div className="sheet-section-label">选择工具</div>
    <div className="tool-grid">{tools.map((item) => <button className={`tool-option ${selected?.id === item.id ? 'is-selected' : ''}`} key={item.id} onClick={() => setTool(item.id)}><span className="tool-avatar">{item.displayName.slice(0, 1)}</span><span>{item.displayName}</span>{selected?.id === item.id && <Icon name="check" size={16} />}</button>)}</div>
    {!tools.length && <p className="inline-error">正在读取桌面端工具，请确认连接后重试。</p>}
    <label className="sheet-field"><span>电脑上的项目目录 <small>可选</small></span><input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="留空使用电脑桌面" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
    <p className="sheet-footnote">文件夹不存在时会自动创建；相对路径位于电脑桌面下。</p>
    <div className="recent-projects">{[...new Set(sessions.map((item) => item.cwd).filter(Boolean))].slice(0, 5).map((path) => <button key={path} onClick={() => setFolder(path)}><Icon name="folder" size={14} />{projectName(path)}</button>)}</div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <button className="primary-button full-width" disabled={busy || !selected} onClick={() => void launch()}><Icon name="plus" size={18} />{busy ? '正在启动…' : '启动会话'}</button>
    <p className="sheet-footnote">使用电脑上已安装并登录的 AI 工具。</p>
  </Sheet>;
}
