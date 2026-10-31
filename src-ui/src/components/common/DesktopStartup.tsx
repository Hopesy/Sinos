import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { commands, isTauri } from '../../tauri';
import { IS_MACOS } from '../../lib/platform';
import { RevealMainWindow } from './RevealMainWindow';
import mark from '../../assets/sinos-icon.svg?raw';
import './DesktopStartup.css';

const copy = {
  'zh-CN': { tagline: '让想法，从这里发生。', loading: '正在准备你的工作区', ready: '一切就绪，即刻启程', slow: '启动用时稍长，正在继续准备', enter: '进入工作区', reload: '重新加载', close: '关闭', minimize: '最小化' },
  'zh-TW': { tagline: '讓想法，從這裡發生。', loading: '正在準備你的工作區', ready: '一切就緒，即刻啟程', slow: '啟動稍久，正在繼續準備', enter: '進入工作區', reload: '重新載入', close: '關閉', minimize: '最小化' },
  en: { tagline: 'A place for your next idea.', loading: 'Preparing your workspace', ready: 'Ready for what comes next', slow: 'Taking a little longer. Still preparing.', enter: 'Enter workspace', reload: 'Reload', close: 'Close', minimize: 'Minimize' },
  ja: { tagline: '次のアイデアは、ここから。', loading: 'ワークスペースを準備中', ready: '準備完了。さあ、始めましょう', slow: '少し時間がかかっています。準備中です', enter: 'ワークスペースへ', reload: '再読み込み', close: '閉じる', minimize: '最小化' },
  ko: { tagline: '다음 아이디어가 시작되는 곳.', loading: '작업 공간을 준비하고 있어요', ready: '준비 완료. 이제 시작해 보세요', slow: '조금 더 시간이 필요해요. 준비 중입니다', enter: '작업 공간 열기', reload: '새로 고침', close: '닫기', minimize: '최소화' },
};
function startupLanguage() {
  try { return localStorage.getItem('cc-lang') || 'zh-CN'; } catch { return 'zh-CN'; }
}

/** The startup surface and workspace share a window; the workspace mounts only
 * after its dependencies settle, and stays covered until its committed paint. */
export function DesktopStartup({ ready, scaleReady, children }: { ready: Promise<unknown>; scaleReady: Promise<unknown>; children: ReactNode }) {
  const [language] = useState(startupLanguage);
  const text = copy[language as keyof typeof copy] ?? copy.en;
  const [loaded, setLoaded] = useState(false);
  const [scaled, setScaled] = useState(false);
  const [revealedAt, setRevealedAt] = useState<number>();
  const [painted, setPainted] = useState(false);
  const [phase, setPhase] = useState<'opening' | 'leaving' | 'done'>('opening');
  const [slow, setSlow] = useState(false);
  const onRevealed = useCallback(() => setRevealedAt(performance.now()), []);

  useEffect(() => {
    let active = true;
    void ready.then(() => { if (active) setLoaded(true); });
    void scaleReady.then(() => { if (active) setScaled(true); });
    const timer = setTimeout(() => { if (active) setSlow(true); }, 8000);
    return () => { active = false; clearTimeout(timer); };
  }, [ready, scaleReady]);

  useEffect(() => {
    if (!loaded || revealedAt === undefined) return;
    let second: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        setPainted(true);
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 950;
        timer = setTimeout(() => setPhase('leaving'), Math.max(0, duration - (performance.now() - revealedAt)));
      });
    });
    return () => { cancelAnimationFrame(first); if (second !== undefined) cancelAnimationFrame(second); clearTimeout(timer); };
  }, [loaded, revealedAt]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280;
    const timer = setTimeout(() => setPhase('done'), duration);
    return () => clearTimeout(timer);
  }, [phase]);

  const drag = async (event: React.MouseEvent) => {
    if (!isTauri || event.button !== 0 || (event.target as Element).closest('button')) return;
    try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().startDragging(); } catch { /* Window may already be closing. */ }
  };

  return <>
    {loaded && <div className="desktop-workspace" inert={phase !== 'done'} aria-hidden={phase !== 'done'}>{children}</div>}
    {phase !== 'done' && <section className={`desktop-startup is-${phase}`} role="dialog" aria-modal="true" aria-labelledby="startup-brand" lang={language}>
      <header className="startup-header" onMouseDown={drag}>
        <span className="startup-edition">SINOS <span>/</span> DESKTOP</span>
        {!IS_MACOS && <div className="startup-window-controls">
          <button type="button" aria-label={text.minimize} onClick={() => { if (isTauri) void commands.windowMinimize().catch(() => {}); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" /></svg></button>
          <button type="button" aria-label={text.close} onClick={() => { if (isTauri) void commands.windowClose().catch(() => {}); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
        </div>}
      </header>
      <div className="startup-ceremony">
        <div className="startup-orbit" aria-hidden="true"><i /><i /><span>+</span><span>+</span></div>
        <div className="startup-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark }} />
        <p className="startup-eyebrow">YOUR MULTI-AGENT WORKSPACE</p>
        <h1 id="startup-brand">sinos<span>_</span></h1>
        <p className="startup-tagline">{text.tagline}</p>
        <div className="startup-status" role="status" aria-live="polite"><span className={`startup-light${painted ? ' is-ready' : ''}`} />{painted ? text.ready : slow ? text.slow : text.loading}</div>
        <div className="startup-action">
          {painted ? <button type="button" onClick={() => setPhase('leaving')}>{text.enter}<span aria-hidden="true">↗</span></button> : slow ? <button type="button" onClick={() => window.location.reload()}>{text.reload}</button> : null}
        </div>
      </div>
      <footer className="startup-footer"><span>THINK. BUILD. BEGIN.</span><span>SINOS CLI <span className="startup-footer-dot">·</span> EST. 2026</span></footer>
    </section>}
    {scaled && <RevealMainWindow onRevealed={onRevealed} />}
  </>;
}
