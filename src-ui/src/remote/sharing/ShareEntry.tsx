import { useEffect, useState } from 'react';
import { Eye, MousePointer2, Share2 } from 'lucide-react';
import { RelayClient } from '../pair/RelayClient';
import { useConnection } from '../useConnection';
import { ChatView } from '../ChatView';
import { useMobileViewport } from '../useMobileViewport';
import { usePhoneAppearance } from '../usePhoneAppearance';
import { claimShare, forgetShare, savedShare, shareError } from './shareClient';
import '../RemoteApp.css';
import '../PhoneWorkspace.css';
import '../ConversationPresentation.css';
import './Sharing.css';

export function ShareEntry({ id }: { id: string }) {
  useMobileViewport();
  const appearance = usePhoneAppearance();
  const [device, setDevice] = useState(() => savedShare(id));
  const [client, setClient] = useState<RelayClient | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [left, setLeft] = useState(false);
  useEffect(() => {
    if (!device || left) return;
    const relay = new RelayClient(device); setClient(relay);
    return () => relay.dispose();
  }, [device, left]);
  const leave = () => { client?.dispose(); forgetShare(id); setClient(null); setDevice(null); setLeft(true); };
  async function claim() {
    if (busy) return;
    setBusy(true); setError('');
    try { setDevice(await claimShare(id)); }
    catch (cause) { setError(shareError(cause)); } finally { setBusy(false); }
  }
  if (client && !left) return <GuestWorkspace id={id} client={client} onLeave={leave} />;
  return <div className="remote-app pair-screen" data-mobile-theme={appearance.theme} style={appearance.style}><div className="pair-card"><Share2 size={30} /><h1>{left ? '已退出分享' : 'Sinos 临时会话'}</h1><p>{left ? '本页的访问记录已清除。' : '实时接续分享者的会话。连接后会显示只读或控制权限，无需配对电脑。'}</p>{!left && <button className="primary-button full-width" disabled={busy || !/^[\w-]{43}$/.test(id)} onClick={() => void claim()}>{busy ? '正在领取…' : '领取访问并打开'}</button>}<p className="sheet-footnote">只能领取一次。电脑与终端需要保持运行。</p>{error && <p role="alert" className="inline-error">{error}</p>}</div></div>;
}

function GuestWorkspace({ id, client, onLeave }: { id: string; client: RelayClient; onLeave: () => void }) {
  const { state, connection, refresh } = useConnection(client);
  const appearance = usePhoneAppearance();
  const [title, setTitle] = useState('共享会话'), [cwd, setCwd] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const access = state.share, session = state.sessions[0];
  const ended = connection === 'unauthorized' || Boolean(access && now >= access.expiresAt) || (connection === 'online' && (!access || !session));
  useEffect(() => { if (ended) { client.dispose(); forgetShare(id); } }, [client, ended, id]);
  return <div className="remote-app phone-workspace" data-mobile-theme={appearance.theme} style={appearance.style}><div className="phone-shell">
    <header className="phone-header"><div className="phone-heading"><strong>{title}</strong><span className="phone-project-path" title={cwd || session?.cwd}>{cwd || session?.cwd || '正在连接…'}</span></div></header>
    <div className="share-banner"><span>{access?.mode === 'control' ? <MousePointer2 size={13} /> : <Eye size={13} />} {ended ? '分享已结束' : access ? `${access.mode === 'control' ? '允许控制当前会话' : '只读 · 实时同步'} · 剩余 ${Math.max(0, Math.ceil((access.expiresAt - now) / 60000))} 分钟` : '正在验证访问权限…'}</span><button onClick={onLeave}>退出</button></div>
    {!ended && connection !== 'online' && <div className="phone-network" role="status"><span>{connection === 'replaced' ? '此访问已在另一页面打开' : '电脑暂时离线，正在重新连接…'}</span><button onClick={() => { client.resumeHere(); refresh(); }}>重试</button></div>}
    <main className="phone-main">{ended ? <div className="phone-welcome"><h1>分享已结束</h1><p>链接已到期、被撤销或终端已关闭。</p><button className="primary-button" onClick={onLeave}>退出</button></div> : session && access ? <ChatView key={session.id} client={client} session={session} online={connection === 'online'} capabilities={state.capabilities} toolName={session.tool === 'claude' ? 'Claude Code' : session.tool === 'codex' ? 'Codex' : 'Terminal'} onTitle={setTitle} onCwd={setCwd} readOnly={access.mode === 'view'} ephemeralDrafts insert="" onInserted={() => {}} /> : <div className="phone-welcome" role="status">正在连接共享会话…</div>}</main>
  </div></div>;
}
