import { useEffect, useRef, useState } from 'react';
import { Check, Clock3, Copy, Eye, Link2, LoaderCircle, MousePointer2, Share2, X } from 'lucide-react';
import { Sheet } from '../Sheet';
import { RelayClient } from '../pair/RelayClient';
import { clipboardWrite } from '../../lib/clipboard';
import { shareError } from './shareClient';
import './Sharing.css';

interface Share { id: string; mode: 'view' | 'control'; state: 'pending' | 'claimed' | 'connected' | 'ended'; expiresAt: number; inviteExpiresAt: number; url: string | null }
export function ShareSheet({ client, sessionId, onClose }: { client: RelayClient; sessionId: string; onClose: () => void }) {
  const [mode, setMode] = useState<'view' | 'control'>('view');
  const [minutes, setMinutes] = useState(60);
  const [shares, setShares] = useState<Share[]>([]);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [copied, setCopied] = useState(''), [created, setCreated] = useState('');
  const revision = useRef(0), pending = useRef(false), resultRef = useRef<HTMLElement>(null);
  const busy = operation !== null;
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const started = revision.current;
      try {
        const result = await client.rpc<{ shares: Share[] }>('session.share_list', sessionId);
        if (!disposed && started === revision.current) { setShares(result.shares); setLoadError(''); }
      } catch { if (!disposed && started === revision.current) setLoadError('分享记录暂未同步，请检查手机与电脑的连接。'); }
      finally { if (!disposed) timer = setTimeout(refresh, 3000); }
    };
    void refresh(); return () => { disposed = true; clearTimeout(timer); };
  }, [client, sessionId]);
  useEffect(() => {
    if (created) resultRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [created]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(''), 2000); return () => clearTimeout(timer); }, [copied]);
  async function create() {
    if (pending.current) return;
    pending.current = true; revision.current++;
    setOperation('create'); setError(''); setLoadError('');
    try {
      const share = await client.rpc<Share>('session.share_create', sessionId, { mode, minutes });
      revision.current++; setShares(previous => [share, ...previous.filter(item => item.id !== share.id)]); setCreated(share.id);
    } catch (cause) { setError(shareError(cause)); }
    finally { pending.current = false; setOperation(null); }
  }
  async function revoke(id: string) {
    if (pending.current) return;
    pending.current = true; revision.current++;
    setOperation(id); setError('');
    try {
      const result = await client.rpc<Share>('session.share_revoke', sessionId, { id });
      revision.current++; setShares(previous => previous.map(share => share.id === id ? result : share));
      if (created === id) setCreated('');
    } catch (cause) { setError(shareError(cause)); }
    finally { pending.current = false; setOperation(null); }
  }
  async function copy(share: Share) {
    setError(''); setCopied('');
    try { await clipboardWrite(share.url!, { throwOnError: true }); setCopied(share.id); }
    catch { setError('复制失败，请长按链接复制。'); }
  }
  async function send(share: Share) {
    try { if (navigator.share) await navigator.share({ title: 'Sinos 临时会话', url: share.url! }); else await copy(share); }
    catch (cause) { if (!(cause instanceof Error && cause.name === 'AbortError')) setError('分享未完成，可以复制链接发送。'); }
  }
  return <Sheet title="分享当前会话" onClose={onClose}><div className="share-panel">
    <p className="share-intro">邀请他人实时查看，或一起操作这个会话。</p>
    <div className="share-modes" role="group" aria-label="访客权限">
      <button disabled={busy} aria-pressed={mode === 'view'} onClick={() => setMode('view')}><span className="share-mode-icon"><Eye size={18} /></span><strong>只读查看</strong><small>对话与执行进度</small>{mode === 'view' && <Check className="share-mode-check" size={14} />}</button>
      <button disabled={busy} aria-pressed={mode === 'control'} onClick={() => setMode('control')}><span className="share-mode-icon"><MousePointer2 size={18} /></span><strong>允许控制</strong><small>发消息、确认与停止</small>{mode === 'control' && <Check className="share-mode-check" size={14} />}</button>
    </div>
    {mode === 'control' && <p className="share-control-note">访客的指令会在当前会话执行，可能修改项目文件。</p>}
    <fieldset className="share-duration" disabled={busy}><legend><Clock3 size={14} />访问有效期</legend><div>{([15, 60, 240] as const).map(value => <label key={value}><input type="radio" name="share-duration" value={value} checked={minutes === value} onChange={() => setMinutes(value)} /><span>{value === 15 ? '15 分钟' : value === 60 ? '1 小时' : '4 小时'}</span></label>)}</div></fieldset>
    <p className="share-expiry-note">从生成时开始计时 · 链接须在 10 分钟内领取</p>
    <button className="primary-button full-width share-create" disabled={busy} aria-busy={operation === 'create'} onClick={() => void create()}>{operation === 'create' ? <LoaderCircle className="share-spinner" size={18} /> : created ? <Check size={18} /> : <Link2 size={18} />}{operation === 'create' ? '正在生成链接…' : error ? '重新生成链接' : created ? '再生成一个链接' : '生成一次性链接'}</button>
    {operation === 'create' && <p className="share-feedback" role="status">正在与电脑建立临时分享，请稍候…</p>}
    {(error || loadError) && <p className="inline-error share-feedback" role="alert">{error || loadError}</p>}
    <div className="share-list">{[...shares].sort((a, b) => Number(b.id === created) - Number(a.id === created) || b.expiresAt - a.expiresAt).map(share => <section ref={share.id === created ? resultRef : undefined} className={'share-item' + (share.id === created ? ' is-new' : '')} key={share.id}>
      {share.id === created && share.url && <p className="share-ready" role="status"><Check size={15} />链接已生成，复制或分享给对方</p>}
      <div className="share-item-heading"><span className="share-item-mode">{share.mode === 'view' ? <Eye size={15} /> : <MousePointer2 size={15} />}<strong>{share.mode === 'view' ? '只读' : '可控制'}</strong></span><span className={'share-state is-' + share.state}>{({ pending: '等待领取', claimed: '已领取', connected: '已连接', ended: '已结束' })[share.state]}</span>{share.state !== 'ended' && <button className="icon-button" aria-label="撤销分享" disabled={busy} onClick={() => void revoke(share.id)}>{operation === share.id ? <LoaderCircle className="share-spinner" size={15} /> : <X size={16} />}</button>}</div>
      <small className="share-time"><Clock3 size={12} />{new Date(share.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 到期</small>
      {share.url && <><div className="share-url"><Link2 size={14} /><input readOnly aria-label="分享链接" value={share.url} onFocus={event => event.target.select()} /></div><div className="share-link-actions"><button className="share-copy" onClick={() => void copy(share)}>{copied === share.id ? <Check size={15} /> : <Copy size={15} />}{copied === share.id ? '已复制' : '复制链接'}</button><button onClick={() => void send(share)}><Share2 size={15} />分享</button></div></>}
    </section>)}</div>
    <p className="share-footnote">仅限当前会话 · 一次领取 · 随时撤销<br />访问期间可断线重连，终端结束后失效。</p>
  </div></Sheet>;
}
