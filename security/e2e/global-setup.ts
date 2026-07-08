import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Playwright harness setup (SECURITY-TEST-PLAN §3). Seeds a published game
 * (frontend on :4000), three users with live sessions, and two instances:
 *   - instance A: F-row tests (handshake only; needs no live game server).
 *   - instance B: the full play test (a game server is spawned by play.spec).
 * Writes .seed.json for the specs and returns the DB pool teardown.
 */
const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const securityRoot = path.resolve(e2eDir, '..');
const repoRoot = path.resolve(securityRoot, '..');
const seedPath = path.join(e2eDir, '.seed.json');
export const HUB_LOG = path.join(e2eDir, '.hub.log');
export const GAME_LOG = path.join(e2eDir, '.game.log');

const DB = process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

function ensureBuilds(): void {
  const artifacts = [
    path.join(repoRoot, 'apps/hub/.next/BUILD_ID'),
    path.join(repoRoot, 'examples/tictactoe/frontend/public/bundle.js'),
    path.join(repoRoot, 'examples/tictactoe/server/dist/index.js'),
  ];
  if (artifacts.every((a) => existsSync(a))) return;
  execFileSync('pnpm', ['-w', 'build'], { cwd: repoRoot, stdio: 'inherit' });
}

async function seed(client: pg.Client) {
  const domain = 'e2e.local';
  const pattern = `%@${domain}`;
  // Clean any prior e2e rows (FK order). An e2e instance is one created by an
  // e2e user OR one whose game version belongs to an e2e game (a non-e2e user
  // may have created an instance of an e2e game during manual testing).
  const e2eInstances = `SELECT id FROM instance WHERE created_by LIKE $1
     OR game_version_id IN (SELECT id FROM game_version WHERE game_id IN (SELECT id FROM game WHERE host_email LIKE $1))`;
  await client.query(`DELETE FROM ledger WHERE email LIKE $1 OR instance_id IN (${e2eInstances})`, [pattern]);
  await client.query(`DELETE FROM instance_player WHERE email LIKE $1 OR instance_id IN (${e2eInstances})`, [pattern]);
  await client.query(`DELETE FROM instance WHERE created_by LIKE $1
     OR game_version_id IN (SELECT id FROM game_version WHERE game_id IN (SELECT id FROM game WHERE host_email LIKE $1))`, [pattern]);
  await client.query('DELETE FROM game_version WHERE game_id IN (SELECT id FROM game WHERE host_email LIKE $1)', [pattern]);
  await client.query('DELETE FROM game WHERE host_email LIKE $1', [pattern]);
  await client.query('DELETE FROM sessions s USING users u WHERE s."userId" = u.id AND u.email LIKE $1', [pattern]);
  await client.query('DELETE FROM users WHERE email LIKE $1', [pattern]);
  await client.query('DELETE FROM participant WHERE email LIKE $1', [pattern]);

  const mkParticipant = async (email: string, roles: string[] = [], username: string | null = null) =>
    client.query(
      `INSERT INTO participant (email, status, roles, username) VALUES ($1, 'approved', $2, $3)
       ON CONFLICT (email) DO UPDATE SET status = 'approved', roles = $2, username = $3`,
      [email, roles, username],
    );

  const mkSession = async (email: string): Promise<string> => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO users (name, email) VALUES ($1, $1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [email],
    );
    const token = randomBytes(32).toString('hex');
    await client.query('INSERT INTO sessions ("userId", "sessionToken", expires) VALUES ($1, $2, $3)', [
      rows[0]!.id,
      token,
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    ]);
    return token;
  };

  const host = `host@${domain}`;
  const p1 = `p1@${domain}`;
  const p2 = `p2@${domain}`;
  const nm = `nm@${domain}`;
  // p1/p2 get short, Krmx-valid usernames (the ticket `name`); settlement maps
  // those back to emails. Sequential — these share one pg client.
  await mkParticipant(host, ['host']);
  await mkParticipant(p1, [], 'alice');
  await mkParticipant(p2, [], 'bob');
  await mkParticipant(nm);
  await client.query("INSERT INTO ledger (email, type, amount) VALUES ($1, 'grant', 100), ($2, 'grant', 100)", [p1, p2]);

  const webhookSecret = randomBytes(16).toString('hex');
  const gameId = 'ttt-e2e';
  await client.query(
    "INSERT INTO game (id, host_email, name, webhook_secret, status, entry_fee) VALUES ($1, $2, 'Tic Tac Toe (e2e)', $3, 'published', 10)",
    [gameId, host, webhookSecret],
  );
  const { rows: vrows } = await client.query<{ id: number }>(
    `INSERT INTO game_version (game_id, semver, frontend_url, provision_url, max_players)
     VALUES ($1, '1.0.0', 'http://localhost:4000', 'http://localhost:4100/provision', 2) RETURNING id`,
    [gameId],
  );
  const versionId = vrows[0]!.id;

  const tokenA = randomBytes(32).toString('hex');
  const tokenB = randomBytes(32).toString('hex');
  const instA = 'e2e-inst-a';
  const instB = 'e2e-inst-b';

  await client.query(
    `INSERT INTO instance (id, game_version_id, created_by, status, server_url, service_token_hash, last_heartbeat_at)
     VALUES ($1, $2, $3, 'lobby', 'ws://localhost:4290', $4, now())`,
    [instA, versionId, p1, sha256(tokenA)],
  );
  await client.query('INSERT INTO instance_player (instance_id, email, seat) VALUES ($1, $2, 0)', [instA, p1]);

  await client.query(
    `INSERT INTO instance (id, game_version_id, created_by, status, server_url, service_token_hash, last_heartbeat_at)
     VALUES ($1, $2, $3, 'lobby', 'ws://localhost:4200', $4, now())`,
    [instB, versionId, p1, sha256(tokenB)],
  );
  await client.query('INSERT INTO instance_player (instance_id, email, seat) VALUES ($1, $2, 0), ($1, $3, 1)', [
    instB,
    p1,
    p2,
  ]);
  await client.query(
    "INSERT INTO ledger (email, instance_id, type, amount) VALUES ($1, $3, 'entry_hold', -10), ($2, $3, 'entry_hold', -10)",
    [p1, p2, instB],
  );

  const tp1 = await mkSession(p1);
  const tp2 = await mkSession(p2);
  const tnm = await mkSession(nm);
  const seedData = {
    gameId,
    webhookSecret,
    instanceA: instA,
    instanceB: instB,
    serviceTokenB: tokenB,
    gamePort: 4200,
    hubLog: HUB_LOG,
    gameLog: GAME_LOG,
    users: {
      p1: { email: p1, token: tp1 },
      p2: { email: p2, token: tp2 },
      nonMember: { email: nm, token: tnm },
    },
  };
  writeFileSync(seedPath, JSON.stringify(seedData, null, 2));
}

async function globalSetup(): Promise<() => Promise<void>> {
  ensureBuilds();
  execFileSync('node', [path.join(repoRoot, 'apps/hub/db/migrate.mjs')], { stdio: 'inherit' });
  // fresh hub log for H-04
  writeFileSync(HUB_LOG, '');

  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  try {
    await seed(client);
  } finally {
    await client.end();
  }
  return async () => {};
}

export default globalSetup;
