import { useId, useState } from 'react';
import { useAppLanguage } from '../../store/app-state';
import { invoke } from '../../tauri';
import { IS_WINDOWS } from '../../lib/platform';
import { clearUnreadTasks } from '../../lib/session-replies';
import { desktopCopy, notificationEnabled, setNotificationPreference, type NotificationPreference } from '../../lib/notification-preferences';

export function DesktopNotificationSettings() {
  const id = useId();
  const copy = desktopCopy(useAppLanguage());
  const [values, setValues] = useState(() => Object.fromEntries((['done', 'wait', 'badge', 'backgroundOnly'] as const).map(key => [key, notificationEnabled(key)])));
  const [status, setStatus] = useState(''), [pending, setPending] = useState(false);
  const change = (key: NotificationPreference, enabled: boolean) => {
    try { setNotificationPreference(key, enabled); setValues(old => ({ ...old, [key]: enabled })); setStatus(''); }
    catch { setStatus(copy.failed); }
  };
  const preview = async () => {
    setPending(true); setStatus('');
    try { const shown = await invoke<boolean>('show_desktop_notification', { sessionId: '', title: 'Sinos CLI', body: copy.preview }); setStatus(shown ? copy.sent : copy.blocked); }
    catch { setStatus(copy.failed); }
    finally { setPending(false); }
  };
  return <section className="settings-preference-section" aria-labelledby={`${id}-heading`}>
    <h3 className="settings-section-label" id={`${id}-heading`}>{copy.heading}</h3>
    <div className="settings-preference-list">
      {(['done', 'wait', 'badge', 'backgroundOnly'] as const).filter(key => IS_WINDOWS || key === 'badge').map(key => <label className="settings-preference-row" key={key}>
        <span className="settings-preference-label">{copy[key]}</span>
        <input className="settings-switch" type="checkbox" role="switch" checked={values[key]} onChange={event => change(key, event.target.checked)} />
      </label>)}
    </div>
    <p className="settings-preference-hint">{IS_WINDOWS ? copy.hint : copy.badgeHint}</p>
    <div className="settings-preference-actions">
      {IS_WINDOWS && <button type="button" className="settings-btn" disabled={pending} onClick={() => void preview()}>{copy.test}</button>}
      <button type="button" className="settings-scale-reset" onClick={clearUnreadTasks}>{copy.clear}</button>
    </div>
    {status && <p role="status" className="settings-preference-status">{status}</p>}
  </section>;
}
