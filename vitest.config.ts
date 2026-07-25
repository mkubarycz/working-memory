import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'control-plane/tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
