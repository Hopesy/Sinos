import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Package the UI locally. Never grant a remotely hosted page access to native plugins.
export default defineConfig({
  root: resolve(import.meta.dirname, 'remote'),
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [react(), {
    name: 'android-shell',
    transformIndexHtml: html => html.replace(/<link rel="manifest"[^>]*>/, '')
      .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https: wss:; base-uri 'none'; object-src 'none'; form-action 'none'" />`),
  }],
  build: { outDir: '../dist-android', emptyOutDir: true, target: 'es2022' },
});
