import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@aoe-supercharge/core/shared': fileURLToPath(
        new URL('./packages/core/src/shared/index.ts', import.meta.url),
      ),
      '@aoe-supercharge/core/node': fileURLToPath(
        new URL('./packages/core/src/node/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
  },
});
