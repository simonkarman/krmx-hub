import { pool } from './db';

export type ParticipantStatus = 'pending' | 'approved' | 'blocked';
export type Role = 'host' | 'admin';

export interface Participant {
  email: string;
  username: string | null;
  status: ParticipantStatus;
  roles: string[];
  requestedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
}

export interface ParticipantWithBalance extends Participant {
  balance: number;
}

interface ParticipantRow {
  email: string;
  username: string | null;
  status: ParticipantStatus;
  roles: string[];
  requested_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
}

function toParticipant(row: ParticipantRow): Participant {
  return {
    email: row.email,
    username: row.username,
    status: row.status,
    roles: row.roles,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

function adminEmail(): string {
  return process.env.ADMIN_EMAIL ?? 'mail@simonkarman.nl';
}

export async function getParticipant(email: string): Promise<Participant | null> {
  const { rows } = await pool.query<ParticipantRow>('SELECT * FROM participant WHERE email = $1', [email]);
  const row = rows[0];
  return row ? toParticipant(row) : null;
}

/**
 * Creates the participant row on first sign-in (status defaults to 'pending').
 * The ADMIN_EMAIL bootstrap (ARCHITECTURE §2) is applied idempotently so the
 * initial admin is always approved and holds the admin role.
 */
export async function ensureParticipant(email: string): Promise<Participant> {
  await pool.query('INSERT INTO participant (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
  if (email === adminEmail()) {
    await pool.query(
      `UPDATE participant
       SET status = 'approved',
           roles = CASE WHEN 'admin' = ANY(roles) THEN roles ELSE array_append(roles, 'admin') END,
           decided_at = COALESCE(decided_at, now()),
           decided_by = COALESCE(decided_by, 'bootstrap')
       WHERE email = $1`,
      [email],
    );
  }
  const participant = await getParticipant(email);
  if (!participant) throw new Error('participant upsert failed');
  return participant;
}

export async function setParticipantStatus(
  email: string,
  status: 'approved' | 'blocked',
  decidedBy: string,
): Promise<Participant | null> {
  const { rows } = await pool.query<ParticipantRow>(
    'UPDATE participant SET status = $2, decided_at = now(), decided_by = $3 WHERE email = $1 RETURNING *',
    [email, status, decidedBy],
  );
  const row = rows[0];
  return row ? toParticipant(row) : null;
}

export async function grantRole(email: string, role: Role): Promise<Participant | null> {
  const { rows } = await pool.query<ParticipantRow>(
    `UPDATE participant
     SET roles = CASE WHEN $2 = ANY(roles) THEN roles ELSE array_append(roles, $2) END
     WHERE email = $1 RETURNING *`,
    [email, role],
  );
  const row = rows[0];
  return row ? toParticipant(row) : null;
}

export async function revokeRole(email: string, role: Role): Promise<Participant | null> {
  const { rows } = await pool.query<ParticipantRow>(
    'UPDATE participant SET roles = array_remove(roles, $2) WHERE email = $1 RETURNING *',
    [email, role],
  );
  const row = rows[0];
  return row ? toParticipant(row) : null;
}

/**
 * The only ledger write in M1. Ledger rows are written exclusively by
 * hub-internal grant/join/settlement/reap code paths (ARCHITECTURE §9.4).
 */
export async function grantCredits(email: string, amount: number): Promise<void> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('grant amount must be a positive integer');
  }
  await pool.query("INSERT INTO ledger (email, type, amount) VALUES ($1, 'grant', $2)", [email, amount]);
}

export async function getBalance(email: string): Promise<number> {
  const { rows } = await pool.query<{ balance: number }>(
    'SELECT COALESCE(SUM(amount), 0)::int AS balance FROM ledger WHERE email = $1',
    [email],
  );
  return rows[0]?.balance ?? 0;
}

export async function listParticipants(): Promise<ParticipantWithBalance[]> {
  const { rows } = await pool.query<ParticipantRow & { balance: number }>(
    `SELECT p.*, COALESCE(l.balance, 0)::int AS balance
     FROM participant p
     LEFT JOIN (SELECT email, SUM(amount) AS balance FROM ledger GROUP BY email) l USING (email)
     ORDER BY p.requested_at`,
  );
  return rows.map((row) => ({ ...toParticipant(row), balance: row.balance }));
}
