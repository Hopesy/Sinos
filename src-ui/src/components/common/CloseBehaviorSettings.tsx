import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { IS_MACOS } from '../../lib/platform';
import { invoke } from '../../tauri';

interface Preference { closeToTray: boolean; trayAvailable: boolean }
// Keep an accepted save ordered ahead of reads when Settings is closed/reopened.
let saving: Promise<Preference> | undefined;
export function CloseBehaviorSettings() {
  const t = useT();
  const [preference, setPreference] = useState<Preference>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await saving?.catch(() => {});
        const value = await invoke<Preference>('get_close_preference');
        if (active) { setPreference(value); setFailed(false); }
      } catch { if (active) setFailed(true); }
    })();
    return () => { active = false; };
  }, [attempt]);
  const change = async (enabled: boolean) => {
    if (busy.current || !preference || enabled === preference.closeToTray) return;
    busy.current = true; setPending(true); setFailed(false);
    const request = invoke<Preference>('set_close_to_tray', { enabled }); saving = request;
    try { setPreference(await request); } catch { setFailed(true); }
    finally { if (saving === request) saving = undefined; busy.current = false; setPending(false); }
  };
  return <div className="settings-close-behavior settings-preference-section" aria-busy={pending || !preference && !failed}>
    <div className="settings-section-label">{t('settings.closeBehavior')}</div>
    <div className="settings-segmented" role="group" aria-label={t('settings.closeBehavior')}>
      <button type="button" aria-pressed={!!preference && !preference.closeToTray} disabled={pending || !preference} onClick={() => void change(false)}>
        {t(IS_MACOS ? 'settings.closeDock' : 'settings.closeExit')}
      </button>
      <button type="button" aria-pressed={!!preference?.closeToTray} disabled={pending || !preference?.trayAvailable} onClick={() => void change(true)}>
        {t('settings.closeTray')}
      </button>
    </div>
    <p className="settings-preference-hint">{t('settings.closeTray.hint')}</p>
    {preference && !preference.trayAvailable && <p role="status" className="settings-scale-error">{t('settings.closeTray.unavailable')}</p>}
    {failed && <div className="settings-scale-error" role="alert">{t('settings.closeTray.error')}{!preference && <button type="button" className="settings-scale-reset" onClick={() => setAttempt(n => n + 1)}>{t('settings.closeTray.retry')}</button>}</div>}
  </div>;
}
