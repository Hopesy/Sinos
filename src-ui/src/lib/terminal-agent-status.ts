import type { AgentStatus } from '../store/app-state';

/** Reconcile source-verified screen state with native OSC titles. Silence alone
 * cannot finish a turn that the native protocol still reports as active. */
export function createTerminalAgentStatus(
  publish: (status: AgentStatus) => void,
  hasInteraction: () => boolean,
  nativeSubmissionOnly = false,
) {
  let native: AgentStatus | null = null;
  let screen: AgentStatus | null = null;
  let screenAt = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const settle = (delay = 900) => {
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || hasInteraction() || native === 'working' || native === 'wait_input') return;
      screen = 'idle';
      publish('idle');
    }, delay);
  };
  return {
    native(status: AgentStatus) {
      if (disposed) return;
      native = status;
      if (status === 'idle' && hasInteraction()) return;
      if (status === 'idle' && Date.now() - screenAt < 2000 && (screen === 'working' || screen === 'wait_input')) {
        settle();
        return;
      }
      publish(status);
    },
    screen(status: AgentStatus | null, changed: boolean) {
      if (disposed) return;
      if (status) {
        clear();
        screen = status;
        screenAt = Date.now();
        publish(status);
      } else if (changed) settle();
    },
    submitted() {
      if (disposed || nativeSubmissionOnly) return;
      screen = null;
      screenAt = 0;
      publish('working');
      settle(2500);
    },
    stopped() { clear(); native = null; screen = null; if (!disposed) publish('idle'); },
    dispose() { disposed = true; clear(); },
  };
}
