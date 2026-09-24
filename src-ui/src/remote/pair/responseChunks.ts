import { fromBase64Url } from './encoding';

const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 192 * 1024;
export interface ResponseChunk { index?: number; total?: number; data?: unknown }

// Owned by one pending RPC, so disconnect, cancellation and its existing
// deadline also release any partial response. No unsolicited assemblies.
export class ResponseChunks {
  private parts: Uint8Array[] = [];
  private total = 0;
  private size = 0;

  push(frame: ResponseChunk): unknown | null {
    const { index, total, data } = frame;
    if (!Number.isInteger(index) || index !== this.parts.length || !Number.isInteger(total) || !total || total > Math.ceil(MAX_BYTES / CHUNK_BYTES) || total < 1 || index >= total || (this.total && total !== this.total) || typeof data !== 'string' || !data || data.length > CHUNK_BYTES * 4 / 3 || !/^[A-Za-z0-9_-]+$/.test(data)) throw new Error('INVALID_RESPONSE_CHUNK');
    const part = fromBase64Url(data);
    this.total = total; this.size += part.length;
    if (this.size > MAX_BYTES) throw new Error('RESPONSE_TOO_LARGE');
    this.parts.push(part);
    if (this.parts.length !== total) return null;
    const bytes = new Uint8Array(this.size); let offset = 0;
    for (const value of this.parts) { bytes.set(value, offset); offset += value.length; }
    this.parts = [];
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
}
