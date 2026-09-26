import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Eye, EyeOff, LoaderCircle, Plus, QrCode, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { clipboardWrite } from '../../lib/clipboard';
import { RelayDeviceList, type RelayDeviceInfo } from './RelayDeviceList';
import './RelaySettings.css';

interface RelayStatus { relayUrl: string; inviteUrl: string | null; expiresAt: number | null; error: string | null; devices: RelayDeviceInfo[] }
async function call<T>(command: string, args?: Record<string, unknown>) { const { invoke } = await import('@tauri-apps/api/core'); return invoke<T>(command, args); }
export function RelaySettings() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [relay, setRelay] = useState('https://sinos-relay.zhlhopefil.workers.dev');
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
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
    try { setStatus(await call<RelayStatus>(command, args)); return true; }
    catch (cause) { setError(String(cause)); return false; }
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
        <div className="relay-address-field">
          <input id="relay-address-input" type={showAddress ? 'url' : 'password'} value={relay} onChange={e => { setRelay(e.target.value); setTestResult(null); }} placeholder={showAddress ? 'https://relay.example.com' : '*****'} spellCheck={false} autoCapitalize="off" autoComplete="off" disabled={busy || testing} />
          <button className="relay-eye" type="button" aria-label={showAddress ? '隐藏中继地址' : '显示中继地址'} title={showAddress ? '隐藏中继地址' : '显示中继地址'} aria-pressed={showAddress} onClick={() => setShowAddress(value => !value)}>{showAddress ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
        <button className="settings-btn relay-test" aria-label={testing ? '测试中' : '测试连接'} title={testing ? '测试中…' : '测试连接'} disabled={busy || testing || !relay.trim()} onClick={() => void testConnection()}>{testing ? <LoaderCircle size={17} className="relay-spin" /> : <Unplug size={17} />}</button>
      </div>
      {testResult && <p className={`relay-test-result ${testResult.ok ? 'is-success' : 'is-error'}`} role={testResult.ok ? 'status' : 'alert'}>{testResult.message}</p>}
    </div>
    <section className="relay-pair-card" aria-label="手机配对">
      <div className="relay-pair-heading"><span className="relay-pair-icon"><QrCode size={20} strokeWidth={1.6} /></span><div><h3>手机配对</h3><p>{showingInvite ? '扫描二维码，或在手机上打开链接' : '扫码连接，接续电脑会话'}</p></div>
        {!showingInvite && <button className="relay-connect" disabled={busy} onClick={() => void action('relay_create_pairing', { relayUrl: relay })}>{busy ? <LoaderCircle size={14} className="relay-spin" /> : <Plus size={14} />}{busy ? '连接中…' : '连接新设备'}</button>}
      </div>
      {showingInvite && <div className="relay-invite">
      <img src={qr} alt="手机扫码配对二维码" />
      <div className="relay-invite-copy">
        <strong>等待手机配对</strong>
        <span>{seconds} 秒后过期 · 仅限使用一次</span>
        {relay.trim() !== status?.relayUrl && <span>地址已修改，刷新二维码后生效。</span>}
        <div className="relay-actions">
          <button className="settings-btn" disabled={busy} onClick={() => void action('relay_create_pairing', { relayUrl: relay })}><RefreshCw size={13} />刷新</button>
          <button className="settings-btn" onClick={() => { if (status?.inviteUrl) void clipboardWrite(status.inviteUrl).then(() => setCopied(true)).catch(cause => setError(String(cause))); }}>{copied ? '已复制' : '复制链接'}</button>
          <button className="settings-btn" disabled={busy} onClick={() => void action('relay_cancel_pairing')}>取消</button>
        </div>
      </div>
      </div>}
      <div className="relay-security"><ShieldCheck size={13} /><span>端到端加密 · 电脑需保持运行</span></div>
    </section>
    {(error || status?.error) && <p className="relay-error" role="alert">{error || status?.error}</p>}
    <RelayDeviceList devices={status?.devices || []} busy={busy} action={action} />
  </div>;
}
