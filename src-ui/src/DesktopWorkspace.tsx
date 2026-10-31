import { AppProvider } from './store/app-state';
import { App } from './App';

export default function DesktopWorkspace() {
  return <AppProvider><App /></AppProvider>;
}
