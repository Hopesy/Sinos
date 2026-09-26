import { expect, it } from 'vitest';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { phoneCsp, previewCsp } from './mobile-security';

it('ships a production CSP that permits image decoding and shares it with the preview', async () => {
  const buildResult = await build({ configFile: fileURLToPath(new URL('../vite.phone.config.ts', import.meta.url)), logLevel: 'silent', build: { write: false } });
  const outputs = Array.isArray(buildResult) ? buildResult.flatMap(result => result.output) : 'output' in buildResult ? buildResult.output : [];
  const headers = outputs.find(output => output.fileName === '_headers');
  expect(headers?.type).toBe('asset');
  const policy = headers?.type === 'asset' ? String(headers.source) : '';
  expect(policy).toContain(`Content-Security-Policy: ${phoneCsp}`);
  const imagePolicy = (value: string) => value.match(/img-src[^;]+/)?.[0].split(/\s+/);
  expect(imagePolicy(policy)).toContain('blob:');
  expect(imagePolicy(policy)).toContain('data:');
  expect(imagePolicy(previewCsp)).toEqual(imagePolicy(policy));
  expect(policy).toContain("script-src 'self';");
}, 30000);
