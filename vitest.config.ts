import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  resolve: {
    alias: {
      '@zebraa/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@zebraa/ui': path.resolve(__dirname, './packages/ui/src/index.ts'),
    },
  },
});
