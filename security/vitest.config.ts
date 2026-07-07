import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'e2e/**'],
    globalSetup: ['./global-setup.ts'],
    testTimeout: 15_000,
  },
});
