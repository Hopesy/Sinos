import { useState } from 'react';
import { ChevronDown, Pencil, Smartphone, X } from 'lucide-react';

export interface RelayDeviceInfo { pairId: string; deviceName: string; relayUrl: string; online: boolean; state: string; pairedAt: number }
export function RelayDeviceList({ devices, busy, action }: {
  devices: RelayDeviceInfo[]; busy: boolean;
  action: (command: string, args: Record<string, unknown>) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(''), [name, setName] = useState('');
  const sorted = [...devices].sort((a, b) => b.pairedAt - a.pairedAt || a.pairId.localeCompare(b.pairId));
  const online = sorted.filter(device => device.online && device.state !== 'revoked');
  const offline = sorted.filter(device => !device.online || device.state === 'revoked');
  const row = (device: RelayDeviceInfo) => {
    const connected = device.online && device.state !== 'revoked';
    const label = `${device.deviceName} · ${device.pairId.slice(-6)}`;
    return <div className={`relay-device${connected ? ' is-online' : ''}`} key={device.pairId} role="listitem" aria-label={label}>
      <Smartphone size={20} />
      <div className="relay-device-info">
        <strong>{device.deviceName}<span className="relay-device-state">{device.state === 'revoked' ? '已停用' : connected ? '在线' : '离线'}</span></strong>
        <span title={device.pairId}>编号 {device.pairId.slice(-6)} · {new Date(device.pairedAt).toLocaleString([], { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} 配对</span>
        {device.state === 'revoked' && <span>可重试撤销中继凭据</span>}
        {editing === device.pairId && <form className="relay-device-rename" onSubmit={event => {
          event.preventDefault();
          if (!busy && name.trim()) void action('relay_rename_device', { pairId: device.pairId, deviceName: name.trim() }).then(ok => { if (ok) setEditing(''); });
        }}>
          <input aria-label={`设备备注 ${device.pairId.slice(-6)}`} value={name} maxLength={60} autoFocus disabled={busy} onChange={event => setName(event.target.value)} placeholder="例如：我的 Pixel · Chrome" />
          <button className="settings-btn" disabled={busy || !name.trim()} type="submit">保存</button>
          <button className="settings-btn" disabled={busy} type="button" onClick={() => setEditing('')}>取消</button>
        </form>}
      </div>
      {editing !== device.pairId && <div className="relay-device-actions">
        <button className="settings-btn relay-device-icon" disabled={busy} aria-label={`修改备注 ${label}`} title="修改备注" onClick={() => { setEditing(device.pairId); setName(device.deviceName); }}><Pencil size={12} /></button>
        <button className="settings-btn relay-device-icon" disabled={busy} aria-label={`撤销 ${label}`} title="撤销配对" onClick={() => void action('relay_revoke_device', { pairId: device.pairId })}><X size={12} /></button>
      </div>}
    </div>;
  };
  return <div className="relay-devices">
    <h4>当前在线 <span>{online.length}</span></h4>
    {online.length ? <div role="list" aria-label="在线设备">{online.map(row)}</div> : <p className="relay-empty">暂无在线设备。已配对的手机打开原网页或 App 即可重连。</p>}
    {offline.length > 0 && <details className="relay-saved-devices">
      <summary><ChevronDown size={14} />离线配对记录 <span>{offline.length}</span></summary>
      <p className="relay-device-help">重复扫码会留下多条配对记录，可修改备注或撤销不用的记录。</p>
      <div role="list" aria-label="离线配对记录">{offline.map(row)}</div>
    </details>}
  </div>;
}
