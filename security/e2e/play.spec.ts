import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Frame } from '@playwright/test';
import pg from 'pg';
import { JWT_PATTERN, seed, sessionCookie } from './seed';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB = process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub';

let gameServer: ChildProcess;
const browserConsole: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  gameServer = spawn('node', [path.join(repoRoot, 'examples/tictactoe/server/dist/index.js')], {
    env: {
      ...process.env,
      GAME_PORT: String(seed.gamePort),
      INSTANCE_ID: seed.instanceB,
      HUB_URL: 'http://localhost:3000',
      SERVICE_TOKEN: seed.serviceTokenB,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(seed.gameLog);
  gameServer.stdout?.pipe(log);
  gameServer.stderr?.pipe(log);
  await new Promise((r) => setTimeout(r, 1500)); // let it bind the port
});

test.afterAll(() => {
  gameServer?.kill('SIGTERM');
});

async function openPlayer(browser: Browser, token: string): Promise<Frame> {
  const ctx = await browser.newContext();
  await ctx.addCookies([sessionCookie(token)]);
  const page = await ctx.newPage();
  page.on('console', (m) => browserConsole.push(m.text()));
  await page.goto(`/play/${seed.instanceB}`);
  const el = await page.waitForSelector('iframe', { timeout: 15_000 });
  const frame = await el.contentFrame();
  if (!frame) throw new Error('no frame');
  await frame.waitForFunction(() => (window as unknown as { __hub?: { ready?: boolean } }).__hub?.ready === true, null, {
    timeout: 15_000,
  });
  return frame;
}

const cell = (frame: Frame, i: number) => frame.locator(`[data-cell="${i}"]`);

test('two players play a full game and credits settle', async ({ browser }) => {
  // p1 links first → becomes X; wait until it is registered before p2 joins.
  const f1 = await openPlayer(browser, seed.users.p1.token);
  await expect(f1.locator('#status')).toContainText('Waiting for opponent', { timeout: 15_000 });
  const f2 = await openPlayer(browser, seed.users.p2.token);

  // Both present now; X (p1) to move.
  await expect(f1.locator('#status')).toContainText('Your move', { timeout: 15_000 });

  // X wins the top row: X0, O3, X1, O4, X2
  await cell(f1, 0).click();
  await expect(cell(f2, 3)).toBeEnabled({ timeout: 10_000 });
  await cell(f2, 3).click();
  await expect(cell(f1, 1)).toBeEnabled({ timeout: 10_000 });
  await cell(f1, 1).click();
  await expect(cell(f2, 4)).toBeEnabled({ timeout: 10_000 });
  await cell(f2, 4).click();
  await expect(cell(f1, 2)).toBeEnabled({ timeout: 10_000 });
  await cell(f1, 2).click();

  await expect(f1.locator('#status')).toContainText('You win', { timeout: 10_000 });

  // Settlement: winner (p1) takes the pot of 20 → 110; loser (p2) → 90.
  const pool = new pg.Pool({ connectionString: DB });
  try {
    const balance = async (email: string) =>
      (
        await pool.query<{ b: number }>('SELECT COALESCE(SUM(amount),0)::int AS b FROM ledger WHERE email = $1', [
          email,
        ])
      ).rows[0]!.b;

    await expect.poll(async () => balance(seed.users.p1.email), { timeout: 10_000 }).toBe(110);
    expect(await balance(seed.users.p2.email)).toBe(90);
    const status = (
      await pool.query<{ status: string }>('SELECT status FROM instance WHERE id = $1', [seed.instanceB])
    ).rows[0]!.status;
    expect(status).toBe('finished');
  } finally {
    await pool.end();
  }
});

test('H-04 captured logs contain no ticket, service-token or webhook-secret material', () => {
  const hubLog = readFileSync(seed.hubLog, 'utf8');
  const gameLog = readFileSync(seed.gameLog, 'utf8');
  const browserLog = browserConsole.join('\n');

  for (const [name, log] of [
    ['hub', hubLog],
    ['game', gameLog],
    ['browser', browserLog],
  ] as const) {
    expect(log, `${name} log must contain no JWT`).not.toMatch(JWT_PATTERN);
    expect(log.includes(seed.serviceTokenB), `${name} log must not contain the service token`).toBe(false);
    expect(log.includes(seed.webhookSecret), `${name} log must not contain the webhook secret`).toBe(false);
  }
});
