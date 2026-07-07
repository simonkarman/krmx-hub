import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from './db';

/** Base URL of the hub started by global-setup.ts. */
export const HUB_URL = process.env.HUB_URL ?? 'http://localhost:3210';

/** All seeded rows use this domain so cleanup can find them. */
export const TEST_EMAIL_DOMAIN = 'sec-test.local';

export function testEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@${TEST_EMAIL_DOMAIN}`;
}

export async function seedParticipant(
  email: string,
  status: 'pending' | 'approved' | 'blocked',
  roles: string[] = [],
): Promise<void> {
  await pool.query(
    `INSERT INTO participant (email, status, roles) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET status = $2, roles = $3`,
    [email, status, roles],
  );
}

/**
 * Forges a live browser session the same way Auth.js database sessions work:
 * users row + sessions row + cookie. No hub code involved, so tests control
 * session and participant state independently (e.g. blocked user with a
 * still-live session for A-02).
 */
export async function createSessionCookie(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (name, email) VALUES ($1, $1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email],
  );
  const user = rows[0];
  if (!user) throw new Error('user seed failed');
  const token = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions ("userId", "sessionToken", expires) VALUES ($1, $2, $3)', [
    user.id,
    token,
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  ]);
  return `authjs.session-token=${token}`;
}

export async function api(
  path: string,
  opts: { cookie?: string; method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${HUB_URL}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export async function cleanupTestData(): Promise<void> {
  const pattern = `%@${TEST_EMAIL_DOMAIN}`;
  await pool.query('DELETE FROM ledger WHERE email LIKE $1', [pattern]);
  await pool.query('DELETE FROM sessions s USING users u WHERE s."userId" = u.id AND u.email LIKE $1', [pattern]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [pattern]);
  await pool.query('DELETE FROM participant WHERE email LIKE $1', [pattern]);
}
