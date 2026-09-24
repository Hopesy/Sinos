import { expect, it } from 'vitest';
import { ResponseChunks } from './responseChunks';
import { toBase64Url } from './encoding';

it('reassembles a large JSON response across UTF-8 character boundaries', () => {
  const response = { type: 'response', channel: 'one', id: 'request', data: '中文\n"'.repeat(160_000) };
  const bytes = new TextEncoder().encode(JSON.stringify(response));
  const size = 192 * 1024 - 1, total = Math.ceil(bytes.length / size);
  const chunks = new ResponseChunks(); let result: unknown = null;
  for (let index = 0; index < total; index++) result = chunks.push({ index, total, data: toBase64Url(bytes.subarray(index * size, (index + 1) * size)) });
  expect(result).toEqual(response);
});

it('rejects missing, repeated, inconsistent and oversized parts', () => {
  const part = { index: 0, total: 2, data: 'YQ' };
  expect(() => new ResponseChunks().push({ ...part, index: 1 })).toThrow();
  expect(() => new ResponseChunks().push({ ...part, total: 1000 })).toThrow();
  expect(() => new ResponseChunks().push({ ...part, data: 'A'.repeat(262145) })).toThrow();
  const duplicate = new ResponseChunks(); duplicate.push(part);
  expect(() => duplicate.push(part)).toThrow();
  const mismatch = new ResponseChunks(); mismatch.push(part);
  expect(() => mismatch.push({ ...part, index: 1, total: 3 })).toThrow();
});
