import { useEffect, useState } from 'react';
import { LockKeyhole, ScanLine, Smartphone } from 'lucide-react';
import { RemoteApp } from './RemoteApp';
import { RemoteClient, readPairingToken } from './client';
import { claimDevice, RelayClient, savedDevice } from './pair/RelayClient';
import { parsePairUri } from './pair/encoding';
import { useMobileViewport } from './useMobileViewport';
import './RemoteApp.css';
import './PhoneWorkspace.css';

export function PairEntry() {
  useMobileViewport();
  const [invite, setInvite] = useState(() => location.hash.includes('pk=') ? location.href : '');
  const [link, setLink] = useState('');
  const [client, setClient] = useState<RemoteClient | null>(null);
  const [name, setName] = useState(/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone / iPad' : /Android/.test(navigator.userAgent) ? 'Android 手机' : '我的手机');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (invite) return;
    if (location.pathname.startsWith('/remote')) { setClient(new RemoteClient(location.origin, readPairingToken())); return; }
    const saved = savedDevice();
    if (!saved) return;
    const relay = new RelayClient(saved); setClient(relay);
    return () => relay.dispose();
  }, [invite]);
  useEffect(() => {
    const scan = () => { if (location.hash.includes('pk=')) { if (client instanceof RelayClient) client.dispose(); setClient(null); setInvite(location.href); setError(''); } };
    window.addEventListener('hashchange', scan); return () => window.removeEventListener('hashchange', scan);
  }, [client]);
  async function pair() {
    setBusy(true); setError('');
    try { await claimDevice(invite, name); setInvite(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '配对失败，请重新生成配对链接。'); }
    finally { setBusy(false); }
  }
  function openLink() {
    setError('');
    try {
      const parsed = parsePairUri(link);
      if (parsed.publicKey.length !== 32) throw new Error();
      if (new URL(parsed.relay).origin !== location.origin) {
        setError('此链接属于另一个中继，请直接在浏览器地址栏打开原始 HTTPS 配对链接。');
        return;
      }
      setInvite(link.trim());
    } catch { setError('请粘贴电脑上「连接新设备 → 复制链接」生成的完整配对链接。'); }
  }
  function cancel() {
    history.replaceState(null, '', location.pathname);
    setInvite(''); setError('');
  }
  if (client && !invite) return <RemoteApp client={client} />;
  return <div className="remote-app pair-screen" data-mobile-theme={matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}>
    <div className="pair-card">
      <Smartphone size={32} strokeWidth={1.5} />
      <h1>{invite ? '连接你的电脑' : '连接到 Sinos'}</h1>
      <p>{invite ? '配对后，即可在手机上继续对话、查看代码和编辑项目。' : '首次连接时，扫码或粘贴配对链接。以后打开即可自动重连。'}</p>
      {invite ? <>
        <label className="sheet-field"><span>这台设备的名称</span><input value={name} maxLength={60} onChange={e => setName(e.target.value)} /></label>
        <p className="sheet-footnote"><LockKeyhole size={13} /> 对话和文件在手机与电脑之间加密传输。</p>
        <button className="primary-button full-width" disabled={busy} onClick={() => void pair()}>{busy ? '正在配对…' : '配对并继续'}</button>
        <button className="text-button full-width" disabled={busy} onClick={cancel}>返回</button>
      </> : <>
        <div className="pair-steps">
          <span><b>1</b>电脑打开「设置 → 移动端」</span>
          <span><b>2</b>点击「连接新设备」</span>
          <span><b>3</b><ScanLine size={16} />扫码，或复制链接在手机上打开</span>
        </div>
        <form className="pair-link-form" onSubmit={event => { event.preventDefault(); openLink(); }}>
          <label className="sheet-field"><span>已有配对链接？粘贴到这里</span><input value={link} onChange={e => { setLink(e.target.value); setError(''); }} placeholder="https://…/#pk=…" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} /></label>
          <button className="primary-button full-width" type="submit" disabled={!link.trim()}>继续连接</button>
        </form>
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <a className="license-link" href="/third-party/EnsoCode-LICENSE.txt">开源许可</a>
    </div>
  </div>;
}
