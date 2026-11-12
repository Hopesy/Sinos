import { useEffect } from 'react';
import type { AppState } from '../store/app-state';
import { splitSessionIds } from './session-split-layout';
import { onWindowBackground, onWindowForeground } from './window-focus-filter';
import { updateSessionReplyReaders } from './session-replies';
import { useAgentConversationId } from './agent-client';

export function useSessionReplyVisibility(state: AppState) {
  const agentConversationId = useAgentConversationId();
  const { terminals, activeTerminalId, sessionSplit, usageOpen, toolSettingsOpen, diffTabActive, editorTabActive, agentPageActive, settingsOpen, automationsOpen } = state;
  useEffect(() => {
    const ids = splitSessionIds(sessionSplit);
    const shown = usageOpen || toolSettingsOpen || diffTabActive || editorTabActive || agentPageActive || settingsOpen || automationsOpen || !activeTerminalId ? []
      : ids.length > 1 && ids.includes(activeTerminalId) ? ids : [activeTerminalId];
    if (agentPageActive === 'agent' && !settingsOpen && !usageOpen && !toolSettingsOpen && !diffTabActive && !editorTabActive && !automationsOpen && agentConversationId) shown.push(`agent:${agentConversationId}`);
    const update = () => updateSessionReplyReaders(terminals, shown);
    update();
    const foreground = onWindowForeground(update), background = onWindowBackground(update);
    document.addEventListener('visibilitychange', update);
    return () => { foreground(); background(); document.removeEventListener('visibilitychange', update); };
  }, [terminals, activeTerminalId, sessionSplit, usageOpen, toolSettingsOpen, diffTabActive, editorTabActive, agentPageActive, settingsOpen, agentConversationId, automationsOpen]);
}
