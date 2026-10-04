import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const buildTimestamp = new Date().toISOString();

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [svelte()],
    define: {
      __WM_BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
});