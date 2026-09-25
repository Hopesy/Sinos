import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export default defineConfig({
  root: resolve(import.meta.dirname, 'remote'),
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [react(), {
    name: 'phone-manifest',
    transformIndexHtml: html => html.replace('/remote.webmanifest', '/phone.webmanifest').replace('Sinos · 移动工作台', 'Sinos · 移动工作空间'),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'phone.webmanifest', source: readFileSync(resolve(import.meta.dirname, 'remote/phone.webmanifest'), 'utf8') });
      this.emitFile({ type: 'asset', fileName: '_headers', source: '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: https:; media-src \'self\' data:; font-src \'self\'; connect-src \'self\' wss:; frame-ancestors \'none\'; base-uri \'none\'; object-src \'none\'\n' });
    },
  }],
  build: { outDir: '../dist-phone', emptyOutDir: true, target: ['es2022', 'safari16'] },
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
});
