import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

/**
 * Vite build for the Working Memory webview UI (WM 14.2 "svelte-workstream-editor").
 *
 * The Svelte app is a PORTABLE web bundle: it imports no VS Code APIs and does
 * no DB access — it talks to the extension host purely over a postMessage
 * transport (see `webview-ui/src/lib/transport.ts`). The build emits a single
 * `main.js` + `main.css` into `media/webview-ui/`, which the extension loads
 * into a webview via `asWebviewUri`. Fixed output names (no content hash) keep
 * the extension's asset references stable.
 */
export default defineConfig({
  plugins: [svelte()],
  root: resolve(__dirname, 'webview-ui'),
  build: {
    outDir: resolve(__dirname, 'media/webview-ui'),
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'webview-ui/index.html'),
      output: {
        entryFileNames: 'main.js',
        assetFileNames: 'main.[ext]',
        chunkFileNames: '[name].js',
      },
    },
  },
});
