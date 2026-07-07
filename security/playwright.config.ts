import { defineConfig } from '@playwright/test';

// Two-origin browser harness per docs/SECURITY-TEST-PLAN.md §3. M5 adds
// webServer entries for the hub (localhost:3000), the tictactoe frontend
// (localhost:4000), and the evil frontend (localhost:4666), plus the F-row
// specs in e2e/. Run with `pnpm --filter security test:e2e`.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:3000',
  },
});
