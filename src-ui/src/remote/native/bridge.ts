import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const isAndroidApp = Capacitor.getPlatform() === 'android';
export interface SocketEvent {
  id: string;
  type: 'open' | 'text' | 'binary' | 'close';
  data?: string;
  code?: number;
  reason?: string;
  retrying?: boolean;
}
interface SinosMobilePlugin {
  readPairing(): Promise<{ value?: string }>;
  writePairing(options: { value: string }): Promise<void>;
  clearPairing(): Promise<void>;
  checkStorage(): Promise<void>;
  scan(): Promise<{ value?: string }>;
  requestNotifications(): Promise<void>;
  clipboardRead(): Promise<{ value: string }>;
  clipboardWrite(options: { value: string }): Promise<void>;
  connect(options: { id: string; url: string }): Promise<void>;
  send(options: { id: string; data: string; binary: boolean }): Promise<void>;
  disconnect(options: { id: string }): Promise<void>;
  addListener(event: 'socket', listener: (event: SocketEvent) => void): Promise<PluginListenerHandle>;
}
export const SinosMobile = registerPlugin<SinosMobilePlugin>('SinosMobile');
