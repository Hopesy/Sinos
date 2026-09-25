import { Laptop, Moon, Sun } from 'lucide-react';
import { THEME_COLORS } from '../lib/personalization';
import { zhCN } from '../i18n/zh-CN';
import type { usePhoneAppearance } from './usePhoneAppearance';

export function PhoneAppearanceSettings({ appearance }: { appearance: ReturnType<typeof usePhoneAppearance> }) {
  return <div className="phone-appearance">
    <div className="setting-row"><span>外观</span><div className="segmented-control">
      <button aria-pressed={appearance.mode === 'light'} onClick={() => appearance.setMode('light')}><Sun size={15} />浅色</button>
      <button aria-pressed={appearance.mode === 'dark'} onClick={() => appearance.setMode('dark')}><Moon size={15} />深色</button>
      <button aria-pressed={appearance.mode === 'system'} onClick={() => appearance.setMode('system')}><Laptop size={15} />系统</button>
    </div></div>
    <div className="phone-palette-grid" aria-label="主题颜色">
      {THEME_COLORS.map(item => <button key={item.code} aria-pressed={appearance.color === item.code}
        onClick={() => appearance.setColor(item.code)}>
        <span className="phone-palette-swatch" style={{ background: appearance.theme === 'light' ? item.daySwatch : item.swatch,
          borderColor: appearance.theme === 'light' ? item.dayRing : item.ring }} />
        {zhCN[item.labelKey]}
      </button>)}
    </div>
  </div>;
}
