import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Laptop, Plus, RefreshCw, ShieldCheck, Smartphone, X } from 'lucide-react';
import { clipboardWrite } from '../../lib/clipboard';
import './RelaySettings.css';

interface RelayStatus { relayUrl: string; inviteUrl: string | null; expiresAt: number | null; error: string | null; devices: { pairId: string; deviceName: string; relayUrl: string; online: boolean; state: string; pairedAt: number }[] }
async function call<T>(command: string, args?: Record<string, unknown>) { const { invoke } = await import('@tauri-apps/api/core'); return invoke<T>(command, args); }
export function RelaySettings() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [relay, setRelay] = useState('https://sinos-relay.zhlhopefil.workers.dev');
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [remove, setRemove] = useState('');
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    let disposed = false, loading = false, first = true;
    async function update() {
      if (loading) return; loading = true;
      try { const next = await call<RelayStatus>('relay_status'); if (!disposed) { setStatus(next); if (first) setRelay(next.relayUrl); first = false; } }
      catch (cause) { if (!disposed) setError(String(cause)); }
      finally { loading = false; }
    }
    void update(); const timer = setInterval(() => { setNow(Date.now()); void update(); }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let disposed = false; setQr('');
    if (status?.inviteUrl) void QRCode.toDataURL(status.inviteUrl, { width: 480, margin: 3, errorCorrectionLevel: 'M' }).then(value => { if (!disposed) setQr(value); }).catch(() => setError('二维码生成失败，请刷新。'));
    return () => { disposed = true; };
  }, [status?.inviteUrl]);
  async function action(command: string, args?: Record<string, unknown>) {
    setBusy(true); setError(''); setCopied(false);
    try { setStatus(await call<RelayStatus>(command, args)); setRemove(''); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function testConnection() {
    setTesting(true); setTestResult(null);
    try {
      const result = await call<{ latencyMs: number }>('relay_test_connection', { relayUrl: relay.trim() });
      setTestResult({ ok: true, message: `中继服务可达 · ${result.latencyMs} ms` });
    } catch (cause) { setTestResult({ ok: false, message: String(cause) }); }
    finally { setTesting(false); }
  }
  const seconds = Math.max(0, Math.ceil(((status?.expiresAt || 0) - now) / 1000));
  const showingInvite = Boolean(qr && seconds > 0);
  return <div className="relay-settings">
    <div className="relay-address">
      <label htmlFor="relay-address-input">Cloudflare 中继地址</label>
      <div className="relay-address-row">
        <input id="relay-address-input" type="url" value={relay} onChange={e => { setRelay(e.target.value); setTestResult(null); }} placeholder="https://relay.example.com" spellCheck={false} autoCapitalize="off" autoComplete="off" disabled={busy || testing} aria-describedby="relay-address-help" />
        <button className="settings-btn relay-test" disabled={busy || testing || !relay.trim()} onClick={() => void testConnection()}>{testing ? '测试中…' : '测试连接'}</button>
      </div>
      <p id="relay-address-help">{qr && seconds > 0 && relay.trim() !== status?.relayUrl ? '地址已修改，点击下方“刷新”生成新的配对链接。' : '连接新设备时保存此地址；已有设备继续使用原来的中继。'}</p>
      {testResult && <p className={`relay-test-result ${testResult.ok ? 'is-success' : 'is-error'}`} role={testResult.ok ? 'status' : 'alert'}>{testResult.message}</p>}
    </div>
    {!showingInvite && <div className="relay-intro"><div className="relay-device-art"><Laptop size={36} strokeWidth={1.4} /><span>···</span><Smartphone size={26} strokeWidth={1.4} /></div><h3>把工作带到手机上</h3><p>扫码或打开配对链接，继续对话、查看变更、编辑文件。<br />手机与电脑无需连接同一个网络。</p></div>}
    {showingInvite ? <div className="relay-invite">
      <img src={qr} alt="手机扫码配对二维码" />
      <div className="relay-invite-copy">
        <strong>扫码，或复制链接在手机上打开</strong>
        <span>{seconds} 秒后过期 · 每个配对邀请只能使用一次</span>
        <div className="relay-actions">
          <button className="settings-btn" disabled={busy} onClick={() => void action('relay_create_pairing', { relayUrl: relay })}><RefreshCw size={13} />刷新</button>
          <button className="settings-btn" onClick={() => { if (status?.inviteUrl) void clipboardWrite(status.inviteUrl).then(() => setCopied(true)).catch(cause => setError(String(cause))); }}>{copied ? '已复制' : '复制链接'}</button>
          <button className="settings-btn" disabled={busy} onClick={() => void action('relay_cancel_pairing')}>取消</button>
        </div>
      </div>
    </div> : <button className="relay-connect" disabled={busy} onClick={() => void action('relay_create_pairing', { relayUrl: relay })}><Plus size={16} />{busy ? '正在连接中继…' : '连接新设备'}</button>}
    {(error || status?.error) && <p className="relay-error" role="alert">{error || status?.error}</p>}
    <div className="relay-security"><ShieldCheck size={16} /><span>端到端加密 · 电脑保持运行即可远程使用</span></div>
    <div className="relay-devices"><h4>已配对设备 <span>{status?.devices.length || 0}</span></h4>{!status?.devices.length && <p className="relay-empty">配对后的设备会出现在这里。</p>}{status?.devices.map(device => <div className="relay-device" key={device.pairId}><Smartphone size={20} /><div><strong>{device.deviceName}</strong><span>{device.state === 'revoked' ? '已在本机停用 · 可重试撤销中继凭据' : device.online ? '在线' : '未连接'} · {new Date(device.pairedAt).toLocaleDateString()}</span></div><button className="settings-btn" disabled={busy} onClick={() => { if (remove === device.pairId) void action('relay_revoke_device', { pairId: device.pairId }); else setRemove(device.pairId); }}>{remove === device.pairId ? '确认撤销' : '撤销'}</button>{remove === device.pairId && <button className="settings-btn" aria-label="取消撤销" onClick={() => setRemove('')}><X size={13} /></button>}</div>)}</div>
  </div>;
}
