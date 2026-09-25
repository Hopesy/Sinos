import { SinosMobile, type SocketEvent } from './bridge';
import type { PluginListenerHandle } from '@capacitor/core';

export interface RelaySocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

// Android owns the socket, heartbeat and network reconnects, including while
// the WebView is paused. Only ciphertext crosses this bridge.
export class NativeRelaySocket implements RelaySocket {
  readyState = 0;
  onopen: RelaySocket['onopen'] = null;
  onmessage: RelaySocket['onmessage'] = null;
  onclose: RelaySocket['onclose'] = null;
  private id = crypto.randomUUID();
  private listener?: PluginListenerHandle;
  private closed = false;
  constructor(url: URL) { void this.start(url); }
  private async start(url: URL) {
    try {
      this.listener = await SinosMobile.addListener('socket', this.receive);
      if (this.closed) { await this.listener.remove(); return; }
      await SinosMobile.connect({ id: this.id, url: url.toString() });
      if (this.closed) await SinosMobile.disconnect({ id: this.id });
    } catch {
      if (!this.closed) {
        this.readyState = 3;
        this.onclose?.({ code: 1011, reason: 'native-connection-failed' });
      }
      await this.listener?.remove();
    }
  }
  private receive = (event: SocketEvent) => {
    if (this.closed || event.id !== this.id) return;
    if (event.type === 'open') { this.readyState = 1; this.onopen?.(); }
    else if (event.type === 'close') {
      this.readyState = event.retrying ? 0 : 3;
      this.onclose?.({ code: event.code || 1006, reason: event.reason || '' });
    } else if (event.type === 'text') this.onmessage?.({ data: event.data || '' });
    else if (event.type === 'binary' && event.data) {
      const bytes = Uint8Array.from(atob(event.data), char => char.charCodeAt(0));
      this.onmessage?.({ data: bytes.buffer });
    }
  };
  send(data: string | Uint8Array) {
    let encoded = '';
    if (typeof data !== 'string') {
      // Avoid spreading a 1 MB frame onto the JavaScript call stack.
      for (let i = 0; i < data.length; i += 8192) encoded += String.fromCharCode(...data.subarray(i, i + 8192));
    }
    void SinosMobile.send({ id: this.id, data: typeof data === 'string' ? data : btoa(encoded), binary: typeof data !== 'string' }).catch(() => {
      // The native service emits the disconnect and reconnect lifecycle.
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.readyState = 3;
    void SinosMobile.disconnect({ id: this.id }).catch(() => {});
    void this.listener?.remove();
  }
}
