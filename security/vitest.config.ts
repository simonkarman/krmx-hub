import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Tests always run against current package source, not stale dist builds.
    alias: {
      '@hub/protocol': path.resolve(here, '../packages/protocol/src/index.ts'),
      '@hub/game-server-sdk': path.resolve(here, '../packages/game-server-sdk/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'e2e/**'],
    globalSetup: ['./global-setup.ts'],
    testTimeout: 15_000,
    // One shared hub process + one Postgres, and each file's afterAll clears
    // all test-domain rows. Run files serially so cleanup can't wipe another
    // file's fixtures mid-run; M4's ledger race tests also need serial order.
    fileParallelism: false,
  },
});
