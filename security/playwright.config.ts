import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Two-origin harness per docs/SECURITY-TEST-PLAN.md §3: hub :3000, game
// frontend :4000, evil origin :4666. All three are started here; the DB is
// seeded by global-setup. Runs serially — one hub, one DB, shared game server.
const securityRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(securityRoot, '..');
const hubDir = path.join(repoRoot, 'apps/hub');
const frontendDir = path.join(repoRoot, 'examples/tictactoe/frontend');
const ticketKey = readFileSync(path.join(securityRoot, 'fixtures/ticket-signing-key.pem'), 'utf8');
const hubLog = path.join(securityRoot, 'e2e/.hub.log');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', trace: 'off' },
  webServer: [
    {
      // Redirect stdout to a file so H-04 can scan the hub's real logs.
      command: `sh -c '"${path.join(hubDir, 'node_modules/.bin/next')}" start -p 3000 >> "${hubLog}" 2>&1'`,
      cwd: hubDir,
      url: 'http://localhost:3000',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub',
        AUTH_SECRET: 'e2e-secret',
        AUTH_URL: 'http://localhost:3000',
        AUTH_TRUST_HOST: 'true',
        HUB_URL: 'http://localhost:3000',
        HUB_FRAME_ORIGINS: 'http://localhost:4000',
        HUB_DISABLE_REAPER: '1',
        TICKET_PRIVATE_KEY: ticketKey,
      },
    },
    {
      command: 'node serve.mjs',
      cwd: frontendDir,
      url: 'http://localhost:4000',
      timeout: 30_000,
      reuseExistingServer: false,
      env: { PORT: '4000' },
    },
    {
      command: 'node e2e/static-server.mjs',
      cwd: securityRoot,
      url: 'http://localhost:4666',
      timeout: 30_000,
      reuseExistingServer: false,
      env: { DIR: path.join(securityRoot, 'e2e/evil'), PORT: '4666' },
    },
  ],
});
