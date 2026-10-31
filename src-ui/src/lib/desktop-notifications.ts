import { useEffect } from 'react';
import { useAppDispatch, useAppStateRef } from '../store/app-state';
import { invoke, isTauri } from '../tauri';
import { getToolDisplayName } from './tool-info';
import { isConversationSession } from './chat-tools';
import { openAgentConversation } from './agent-client';
import { playNotifySound } from './notify-sound';
import { getUnreadTaskCount, isReadingSession, subscribeSessionActivity, subscribeSessionReplies, type SessionActivity } from './session-replies';

import { desktopCopy, notificationEnabled, subscribeNotificationPreferences } from './notification-preferences';

let desiredBadge = 0, appliedBadge = -1;
let badgeFlight: Promise<void> | undefined;
export function updateTaskBadge(count: number) {
  if (!isTauri) return;
  desiredBadge = count;
  if (badgeFlight) return;
  let failed = false;
  badgeFlight = (async () => {
    while (appliedBadge !== desiredBadge) {
      const next = desiredBadge;
      await invoke('set_task_badge', { count: next });
      appliedBadge = next;
    }
  })().catch(error => { failed = true; console.warn('[notifications] taskbar update failed', error); }).finally(() => {
    badgeFlight = undefined;
    if (!failed && appliedBadge !== desiredBadge) updateTaskBadge(desiredBadge);
  });
}

export function shouldShowDesktopNotification(event: SessionActivity): boolean {
  return notificationEnabled(event.kind) && (!notificationEnabled('backgroundOnly') || !isReadingSession(event.id));
}

export function useDesktopNotifications() {
  const stateRef = useAppStateRef(), dispatch = useAppDispatch();
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false, stopClick: (() => void) | undefined;
    const syncBadge = () => updateTaskBadge(notificationEnabled('badge') ? getUnreadTaskCount() : 0);
    const stopReplies = subscribeSessionReplies(syncBadge);
    const stopPreferences = subscribeNotificationPreferences(syncBadge); syncBadge();
    const stopActivity = subscribeSessionActivity(event => {
      const state = stateRef.current;
      const terminal = state.terminals.find(tab => tab.id === event.id);
      const agent = event.tool === 'coffee-agent';
      if (!terminal && !agent) return;
      // Native conversations use verified protocol results; terminal mode
      // already plays its sound from the guarded status-transition observer.
      if (agent || isConversationSession(terminal)) {
        try { if (localStorage.getItem(`cc-sound-${event.kind}`) !== 'false') playNotifySound(event.kind); } catch { playNotifySound(event.kind); }
      }
      if (!shouldShowDesktopNotification(event)) return;
      const copy = desktopCopy(state.currentLang);
      const name = agent ? 'Sinos Agent' : getToolDisplayName(event.tool);
      const project = terminal?.folderPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
      void invoke('show_desktop_notification', {
        sessionId: event.id, title: `Sinos CLI · ${event.kind === 'done' ? copy.complete : copy.question}`,
        body: `${[name, project.slice(0, 100)].filter(Boolean).join(' · ')}\n${copy.detail}`,
      }).catch(error => console.warn('[notifications] desktop alert failed', error));
    });
    void import('@tauri-apps/api/event').then(({ listen }) => listen<string>('desktop-notification-activated', async ({ payload }) => {
      if (disposed) return;
      if (payload.startsWith('agent:')) {
        dispatch({ type: 'OPEN_AGENT_PAGE', page: 'agent' });
        dispatch({ type: 'SET_SETTINGS_OPEN', open: false });
        await openAgentConversation(payload.slice(6)).catch(error => console.warn('[notifications] conversation unavailable', error));
      } else if (stateRef.current.terminals.some(tab => tab.id === payload)) {
        dispatch({ type: 'SET_SETTINGS_OPEN', open: false });
        dispatch({ type: 'SET_ACTIVE_TERMINAL', id: payload });
      }
    })).then(stop => { if (disposed) stop(); else stopClick = stop; }).catch(error => console.warn('[notifications] click listener failed', error));
    return () => { disposed = true; stopClick?.(); stopReplies(); stopActivity(); stopPreferences(); };
  }, [stateRef, dispatch]);
}
