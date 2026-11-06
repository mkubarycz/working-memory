import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolveWorkspaceVersion } from '../scripts/release-version.mjs';

const buildTimestamp = new Date().toISOString();
const buildVersion = resolveWorkspaceVersion({ cwd: resolve(__dirname, '..') });

export default defineConfig({
  main: {
    define: {
      __WM_BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
      __WM_BUILD_VERSION__: JSON.stringify(buildVersion),
    },
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