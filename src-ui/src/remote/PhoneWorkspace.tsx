import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Coffee, FileCode2, Folder, GitBranch, Menu, MessageSquare, Monitor, MoreHorizontal, Plus, Settings2, SquarePen, Trash2, X } from 'lucide-react';
import { RemoteClient, errorMessage, projectName, storageRead, storageWrite } from './client';
import { useConnection } from './useConnection';
import { ChatView } from './ChatView';
import { FilesView } from './FilesView';
import { ChangesView } from './ChangesView';
import { LaunchSheet } from './LaunchSheet';
import { Sheet } from './Sheet';
import { RelayClient, forgetDevice } from './pair/RelayClient';
import { isAndroidApp } from './native/bridge';
import { usePhoneAppearance } from './usePhoneAppearance';
import { PhoneAppearanceSettings } from './PhoneAppearanceSettings';
import './RemoteApp.css';
import './PhoneWorkspace.css';
import './ConversationPresentation.css';

type Surface = 'chat' | 'files' | 'changes';
export function PhoneWorkspace({ client }: { client: RemoteClient }) {
  const { state, tools, connection, refresh } = useConnection(client);
  const [selectedId, setSelectedId] = useState(() => storageRead('session'));
  const [pendingLaunch, setPendingLaunch] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('chat');
  const [visited, setVisited] = useState<Set<Surface>>(() => new Set(['chat']));
  const [panel, setPanel] = useState<'sessions' | 'new' | 'tools' | 'settings' | null>(null);
  const appearance = usePhoneAppearance();
  const { theme } = appearance;
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [insert, setInsert] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const selected = state.sessions.find(s => s.id === selectedId) || (pendingLaunch ? undefined : state.sessions[0]);
  const pendingReady = Boolean(pendingLaunch && selected?.id === pendingLaunch);
  const online = connection === 'online';
  const name = (tool: string | null) => tools.find(t => t.id === tool)?.displayName || tool || 'Terminal';
  const show = (next: Surface) => { setSurface(next); setVisited(previous => new Set(previous).add(next)); setPanel(null); };
  const choose = (id: string) => { setPendingLaunch(null); setSelectedId(id); storageWrite('session', id); setVisited(new Set(['chat'])); show('chat'); setNotice(''); setInsert(''); };
  const setTitle = useCallback((title: string) => { if (selected) setTitles(values => values[selected.id] === title ? values : { ...values, [selected.id]: title }); }, [selected]);
  const inserted = useCallback(() => setInsert(''), []);
  const prompt = (text: string) => { setInsert(text); show('chat'); };

  useEffect(() => {
    if (!pendingLaunch) return;
    if (pendingReady) { setPendingLaunch(null); return; }
    const timer = setTimeout(() => { setPendingLaunch(null); setNotice('会话尚未启动，请在电脑上检查工具是否需要安装或登录。'); }, 20000);
    return () => clearTimeout(timer);
  }, [pendingLaunch, pendingReady]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanel(null); };
    document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape);
  }, []);
  async function action(kind: 'pause' | 'kill' | 'interrupt') {
    if (!selected || busy) return;
    setBusy(true);
    try {
      if (kind === 'pause') await client.pause(selected.id, !selected.paused);
      else if (kind === 'interrupt') await client.input(selected.id, '\x03');
      else await client.kill(selected.id);
      setPanel(null); setConfirmKill(false); refresh();
    } catch (cause) { setNotice(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function forget() {
    try { await forgetDevice(); if (client instanceof RelayClient) client.dispose(); location.reload(); }
    catch { setNotice('无法清除配对记录，请重试。'); }
  }
  return <div className="remote-app phone-workspace" data-mobile-theme={theme} style={appearance.style}>
    <div className="phone-shell" inert={panel === 'sessions'}>
      <header className="phone-header">
        <button className="icon-button" aria-label="打开会话列表" onClick={() => setPanel('sessions')}><Menu size={20} /></button>
        <button className="phone-heading" onClick={() => setPanel('sessions')}><strong>{selected ? titles[selected.id] || name(selected.tool) : 'Sinos'}</strong><span>{selected ? projectName(selected.cwd) : '你的移动工作空间'}<i className={`status-dot ${online ? 'is-online' : 'is-pending'}`} /></span></button>
        <button className="icon-button" aria-label="新建会话" disabled={!online} onClick={() => setPanel('new')}><SquarePen size={19} /></button>
        {selected && <button className="icon-button" aria-label="会话工具" onClick={() => { setConfirmKill(false); setPanel('tools'); }}><MoreHorizontal size={21} /></button>}
      </header>
      {!online && <div className="phone-network" role="status"><span className="status-dot" /><span>{connection === 'connecting' ? '正在连接电脑…' : connection === 'unauthorized' ? '配对已失效，请重新配对' : connection === 'paused' ? '连接已暂停，配对记录已保留' : connection === 'replaced' ? '已在另一个页面连接' : '电脑暂时离线，正在重新连接…'}</span><button onClick={() => { if (connection === 'unauthorized' && client instanceof RelayClient) { void forget(); } else { if ((connection === 'replaced' || connection === 'paused') && client instanceof RelayClient) client.resumeHere(); refresh(); } }}>{connection === 'unauthorized' && client instanceof RelayClient ? '重新配对' : connection === 'paused' ? '恢复连接' : connection === 'replaced' ? '在此页面连接' : '重试'}</button></div>}
      {notice && <div className="notice-banner" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={15} /></button></div>}
      {surface !== 'chat' && <div className="surface-header"><button className="text-button" onClick={() => show('chat')}><ArrowLeft size={16} />返回对话</button><span>{{ files: '项目文件', changes: '代码变更' }[surface]}</span></div>}
      {pendingLaunch && <div className="phone-network" role="status">正在电脑上启动会话…</div>}
      <main className="phone-main">
        {selected ? <div className="session-workspace" key={selected.id}>
          <section className="mobile-tab-panel" hidden={surface !== 'chat'} aria-label="对话"><ChatView client={client} session={selected} online={online} capabilities={state.capabilities} toolName={name(selected.tool)} onTitle={setTitle} insert={insert} onInserted={inserted} /></section>
          {visited.has('files') && <section className="mobile-tab-panel auxiliary-surface" hidden={surface !== 'files'} aria-label="项目文件"><FilesView client={client} sessionId={selected.id} online={online} onAttach={path => prompt(`请查看项目文件 ${path}`)} /></section>}
          {visited.has('changes') && <section className="mobile-tab-panel auxiliary-surface" hidden={surface !== 'changes'} aria-label="代码变更"><ChangesView client={client} sessionId={selected.id} active={surface === 'changes'} onPrompt={prompt} /></section>}
        </div> : <div className="phone-welcome" aria-busy={Boolean(pendingLaunch)}><Coffee size={30} strokeWidth={1.5} /><h1>让想法继续。</h1><p>在手机上接续电脑的会话，<br />把下一步交给 AI。</p><button className="primary-button" disabled={!online || Boolean(pendingLaunch)} onClick={() => setPanel('new')}><Plus size={17} />新建会话</button><span>{state.device_name || '等待连接你的电脑'}</span></div>}
      </main>
    </div>
    {panel === 'sessions' && <div className="drawer-backdrop" onClick={() => setPanel(null)}><aside className="session-drawer" role="dialog" aria-modal="true" aria-label="会话列表" onClick={e => e.stopPropagation()}><div className="drawer-brand"><Coffee size={22} /><strong>Sinos</strong><button className="icon-button" aria-label="关闭会话列表" autoFocus onClick={() => setPanel(null)}><X size={18} /></button></div><button className="drawer-new" disabled={!online} onClick={() => setPanel('new')}><SquarePen size={17} />新建会话</button><div className="drawer-sessions">{[...new Set(state.sessions.map(s => s.cwd))].map(cwd => <div className="drawer-group" key={cwd}><p><Folder size={13} />{projectName(cwd)}</p>{state.sessions.filter(s => s.cwd === cwd).map(session => <button key={session.id} className={`drawer-session ${session.id === selected?.id ? 'active' : ''}`} onClick={() => choose(session.id)}><MessageSquare size={15} /><span>{titles[session.id] || name(session.tool)}<small>{session.paused ? '已暂停' : session.activity?.state === 'working' ? '正在生成' : session.activity?.state === 'waiting' ? '等待回答' : session.activity?.state === 'idle' ? '就绪' : session.activity?.state === 'failed' ? '本轮已停止' : '会话已连接'}{session.queued_count ? ' · 待发送 ' + session.queued_count : ''} · {session.id.slice(0, 6)}</small></span>{session.id === selected?.id && <Check size={14} />}</button>)}</div>)}{!state.sessions.length && <p className="drawer-empty">还没有会话</p>}</div><button className="drawer-device" onClick={() => setPanel('settings')}><Monitor size={18} /><span>{state.device_name || '我的电脑'}<small>{online ? '已连接' : '等待连接'}</small></span><Settings2 size={17} /></button></aside></div>}
    {panel === 'new' && <LaunchSheet client={client} tools={tools} sessions={state.sessions} cwd={selected?.cwd || ''} onClose={() => setPanel(null)} onLaunched={id => { choose(id); setPendingLaunch(id); refresh(); }} />}
    {panel === 'tools' && selected && <Sheet title="会话工具" onClose={() => setPanel(null)}><div className="action-list">{([{ id: 'files', label: '项目文件', text: '浏览、编辑和保存', icon: FileCode2 }, { id: 'changes', label: '代码变更', text: '查看当前 Git 差异', icon: GitBranch }] as const).map(item => <button key={item.id} onClick={() => show(item.id)}><item.icon size={19} /><span>{item.label}<small>{item.text}</small></span><ChevronRight size={16} /></button>)}<button disabled={!online || busy} onClick={() => void action('interrupt')}>停止当前生成 <small>发送 Ctrl+C</small></button><button disabled={!online || busy} onClick={() => void action('pause')}>{selected.paused ? '恢复进程' : '暂停进程'}</button><button className="danger-action" disabled={!online || busy} onClick={() => { if (confirmKill) void action('kill'); else setConfirmKill(true); }}><Trash2 size={18} />{confirmKill ? '确认结束此会话' : '结束会话'}</button></div></Sheet>}
    {panel === 'settings' && <Sheet title="连接与显示" onClose={() => setPanel(null)}><div className="connection-card"><Monitor size={25} /><div><strong>{state.device_name || '我的电脑'}</strong><p>{online ? '已连接' : '等待连接'}</p></div></div><dl className="connection-details"><div><dt>连接方式</dt><dd>{client instanceof RelayClient ? 'Cloudflare · 端到端加密' : '本地网络'}</dd></div><div><dt>活动会话</dt><dd>{state.sessions.length}</dd></div></dl><PhoneAppearanceSettings appearance={appearance} />{isAndroidApp && client instanceof RelayClient && <div className="setting-row"><span>后台连接<small>{connection === 'paused' ? '已暂停，配对仍保留' : '由 Android 服务维持，断网后自动重连'}</small></span><button className="text-button" onClick={() => { if (connection === 'paused') client.resumeHere(); else client.pauseConnection(); refresh(); }}>{connection === 'paused' ? '恢复' : '暂停'}</button></div>}<p className="sheet-footnote">{isAndroidApp ? '保持电脑上的 Sinos 运行。重开 App 会自动连接，无需再次扫码。系统强制停止或省电限制可能中断后台连接，返回 App 后会恢复。' : '保持电脑上的 Sinos 运行。可通过浏览器菜单添加到主屏幕，以独立窗口打开。'}</p>{client instanceof RelayClient && <button className="danger-button full-width" onClick={() => { if (!confirmForget) { setConfirmForget(true); return; } void forget(); }}>{confirmForget ? '确认移除本机配对记录' : '断开并忘记这台电脑'}</button>}<a className="license-link" href={isAndroidApp ? "/third-party/android.html" : "/third-party/EnsoCode-LICENSE.txt"} target={isAndroidApp ? undefined : "_blank"} rel="noreferrer">开源许可</a></Sheet>}
  </div>;
}
