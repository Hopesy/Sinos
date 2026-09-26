import { useEffect, useState, type ReactNode } from 'react';
import { LockKeyhole, ScanLine, Smartphone } from 'lucide-react';
import { RemoteApp } from './RemoteApp';
import { RemoteClient, readPairingToken, storageRead, storageWrite } from './client';
import { claimDevice, RelayClient, savedDevice } from './pair/RelayClient';
import { validateInvite } from './pair/deviceStorage';
import { defaultDeviceName } from './pair/deviceName';
import { isAndroidApp, SinosMobile } from './native/bridge';
import { useMobileViewport } from './useMobileViewport';
import { usePhoneAppearance } from './usePhoneAppearance';
import './RemoteApp.css';
import './PhoneWorkspace.css';

function PairScreen({ children }: { children: ReactNode }) {
  const appearance = usePhoneAppearance();
  return <div className="remote-app pair-screen" data-mobile-theme={appearance.theme} style={appearance.style}>{children}</div>;
}

export function PairEntry() {
  useMobileViewport();
  const [invite, setInvite] = useState(() => location.hash.includes('pk=') ? location.href : '');
  const [link, setLink] = useState('');
  const [client, setClient] = useState<RemoteClient | null>(null);
  const [name, setName] = useState(() => storageRead('device-name') || defaultDeviceName(navigator.userAgent, isAndroidApp));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (invite) { setLoading(false); return; }
    if (!isAndroidApp && location.pathname.startsWith('/remote')) { setClient(new RemoteClient(location.origin, readPairingToken())); setLoading(false); return; }
    let cancelled = false;
    let relay: RelayClient | undefined;
    void savedDevice().then(saved => {
      if (!cancelled && saved) { relay = new RelayClient(saved); setClient(relay); }
    }).catch(() => { if (!cancelled) setError('无法读取安全配对记录，请关闭 App 后重新打开。'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; relay?.dispose(); };
  }, [invite]);
  useEffect(() => {
    const scan = () => { if (location.hash.includes('pk=')) { if (client instanceof RelayClient) client.dispose(); setClient(null); setInvite(location.href); setError(''); } };
    window.addEventListener('hashchange', scan); return () => window.removeEventListener('hashchange', scan);
  }, [client]);
  async function pair() {
    setBusy(true); setError('');
    try {
      if (isAndroidApp) await SinosMobile.requestNotifications();
      await claimDevice(invite, name); storageWrite('device-name', name.trim()); setInvite('');
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '配对失败，请重新生成配对链接。'); }
    finally { setBusy(false); }
  }
  function openLink(value = link) {
    setError('');
    try {
      validateInvite(value);
      setInvite(value.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : '请使用电脑上「连接新设备」生成的配对码。'); }
  }
  async function scan() {
    setBusy(true); setError('');
    try { const result = await SinosMobile.scan(); if (result.value) openLink(result.value); }
    catch { setError('无法打开相机，请允许相机权限，或粘贴配对链接。'); }
    finally { setBusy(false); }
  }
  function cancel() {
    history.replaceState(null, '', location.pathname);
    setInvite(''); setError('');
  }
  if (client && !invite) return <RemoteApp client={client} />;
  return <PairScreen>
    <div className="pair-card">
      <Smartphone size={32} strokeWidth={1.5} />
      <h1>{invite ? '连接你的电脑' : '连接到 Sinos'}</h1>
      <p>{invite ? '配对后，即可在手机上继续对话、查看代码和编辑项目。' : '首次连接时，扫码或粘贴配对链接。以后打开即可自动重连。'}</p>
      {loading ? <p role="status">正在恢复连接…</p> : invite ? <>
        <label className="sheet-field"><span>这台设备的名称</span><input value={name} maxLength={60} onChange={e => setName(e.target.value)} /></label>
        <p className="sheet-footnote"><LockKeyhole size={13} /> 对话和文件在手机与电脑之间加密传输。</p>
        {isAndroidApp && <p className="sheet-footnote">配对记录保存在此手机的安全存储中。连接时显示常驻通知，切到后台后继续保持连接。</p>}
        <button className="primary-button full-width" disabled={busy} onClick={() => void pair()}>{busy ? '正在配对…' : '配对并继续'}</button>
        <button className="text-button full-width" disabled={busy} onClick={cancel}>返回</button>
      </> : <>
        <div className="pair-steps">
          <span><b>1</b>电脑打开「设置 → 移动端」</span>
          <span><b>2</b>点击「连接新设备」</span>
          <span><b>3</b><ScanLine size={16} />扫码，或复制链接在手机上打开</span>
        </div>
        {isAndroidApp && <button className="primary-button full-width pair-scan-button" disabled={busy} onClick={() => void scan()}><ScanLine size={20} />{busy ? '正在打开相机…' : '扫码连接电脑'}</button>}
        <form className="pair-link-form" onSubmit={event => { event.preventDefault(); openLink(); }}>
          <label className="sheet-field"><span>已有配对链接？粘贴到这里</span><input value={link} onChange={e => { setLink(e.target.value); setError(''); }} placeholder="https://…/#pk=…" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} /></label>
          <button className="primary-button full-width" type="submit" disabled={!link.trim()}>继续连接</button>
        </form>
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <a className="license-link" href={isAndroidApp ? "/third-party/android.html" : "/third-party/EnsoCode-LICENSE.txt"}>开源许可</a>
    </div>
  </PairScreen>;
}
