import type { PoolClient } from 'pg';
import { pool } from './db';

/**
 * The credit ledger (ARCHITECTURE §5, §6.1/§6.2/§6.4). Every ledger write in
 * the system happens here or in participants.grantCredits (admin grants) —
 * no user-controllable path writes rows (§9.4; audited by L-10).
 *
 * Money soundness rests on two things:
 *  - Balance checks and hold writes share one transaction, serialized per
 *    participant with `SELECT ... FOR UPDATE`, so balance can never go
 *    negative under concurrency (L-06).
 *  - Every terminal transition (settle / cancel) locks the instance row
 *    `FOR UPDATE` first, so an instance settles or cancels exactly once and
 *    each hold is either captured or released, never both (L-01, L-02, L-07).
 */

export type LedgerErrorCode =
  | 'not_found'
  | 'not_approved'
  | 'insufficient_balance'
  | 'not_joinable'
  | 'capacity_full'
  | 'not_settleable'
  | 'invalid_ranking'
  | 'invalid_amount'
  | 'conservation';

export class LedgerError extends Error {
  override name = 'LedgerError';
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Payout {
  email: string;
  amount: number;
}

async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function balance(client: PoolClient, email: string): Promise<number> {
  const { rows } = await client.query<{ balance: number }>(
    'SELECT COALESCE(SUM(amount), 0)::int AS balance FROM ledger WHERE email = $1',
    [email],
  );
  return rows[0]?.balance ?? 0;
}

/**
 * Seats the creator and holds their entry fee as part of instance creation
 * (§6.1 step 2). Runs before provisioning; a provision failure calls
 * cancelInstance to release this hold. Throws LedgerError on a failed balance
 * or approval check, leaving nothing behind.
 */
export async function reserveInstance(input: {
  instanceId: string;
  gameVersionId: number;
  createdBy: string;
  visibility: 'private' | 'public';
  serviceTokenHash: string;
  entryFee: number;
}): Promise<void> {
  await withTx(async (client) => {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM participant WHERE email = $1 FOR UPDATE',
      [input.createdBy],
    );
    const participant = rows[0];
    if (!participant) throw new LedgerError('not_found', 'participant not found');
    if (participant.status !== 'approved') throw new LedgerError('not_approved', 'account not approved');

    if (input.entryFee > 0 && (await balance(client, input.createdBy)) < input.entryFee) {
      throw new LedgerError('insufficient_balance', 'insufficient balance for entry fee');
    }

    await client.query(
      `INSERT INTO instance (id, game_version_id, created_by, visibility, status, service_token_hash)
       VALUES ($1, $2, $3, $4, 'provisioning', $5)`,
      [input.instanceId, input.gameVersionId, input.createdBy, input.visibility, input.serviceTokenHash],
    );
    await client.query('INSERT INTO instance_player (instance_id, email, seat) VALUES ($1, $2, 0)', [
      input.instanceId,
      input.createdBy,
    ]);
    if (input.entryFee > 0) {
      await client.query(
        "INSERT INTO ledger (email, instance_id, type, amount) VALUES ($1, $2, 'entry_hold', $3)",
        [input.createdBy, input.instanceId, -input.entryFee],
      );
    }
  });
}

export type JoinResult = { joined: true; alreadyMember: boolean };

/**
 * Join flow (§6.2): approved + capacity + balance → seat + hold, atomically.
 * Idempotent (L-05) via the instance_player PK plus an explicit membership
 * check inside the locked transaction.
 */
export async function joinInstance(instanceId: string, email: string): Promise<JoinResult> {
  return withTx(async (client) => {
    const { rows } = await client.query<{ status: string; entry_fee: number; max_players: number }>(
      `SELECT i.status, g.entry_fee, gv.max_players
         FROM instance i
         JOIN game_version gv ON gv.id = i.game_version_id
         JOIN game g ON g.id = gv.game_id
        WHERE i.id = $1
        FOR UPDATE OF i`,
      [instanceId],
    );
    const inst = rows[0];
    if (!inst) throw new LedgerError('not_found', 'instance not found');
    if (inst.status !== 'lobby') throw new LedgerError('not_joinable', 'instance is not accepting players');

    const p = await client.query<{ status: string }>('SELECT status FROM participant WHERE email = $1 FOR UPDATE', [
      email,
    ]);
    if (!p.rows[0]) throw new LedgerError('not_found', 'participant not found');
    if (p.rows[0].status !== 'approved') throw new LedgerError('not_approved', 'account not approved');

    const already = await client.query('SELECT 1 FROM instance_player WHERE instance_id = $1 AND email = $2', [
      instanceId,
      email,
    ]);
    if ((already.rowCount ?? 0) > 0) return { joined: true, alreadyMember: true }; // idempotent

    const seatRow = await client.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM instance_player WHERE instance_id = $1',
      [instanceId],
    );
    const seat = seatRow.rows[0]!.n;
    if (seat >= inst.max_players) throw new LedgerError('capacity_full', 'instance is full');

    if (inst.entry_fee > 0 && (await balance(client, email)) < inst.entry_fee) {
      throw new LedgerError('insufficient_balance', 'insufficient balance for entry fee');
    }

    await client.query('INSERT INTO instance_player (instance_id, email, seat) VALUES ($1, $2, $3)', [
      instanceId,
      email,
      seat,
    ]);
    if (inst.entry_fee > 0) {
      await client.query(
        "INSERT INTO ledger (email, instance_id, type, amount) VALUES ($1, $2, 'entry_hold', $3)",
        [email, instanceId, -inst.entry_fee],
      );
    }
    return { joined: true, alreadyMember: false };
  });
}

/**
 * Cancels an active instance and refunds every entry hold (§6.4 reaper; also
 * the provision-failure path). One hold_release per entry_hold. The instance
 * lock + terminal-status guard make this a no-op on an already-terminal
 * instance, so settle-then-cancel never double-resolves (L-02, L-07, L-09).
 * Returns true only if this call performed the cancellation.
 */
export async function cancelInstance(instanceId: string): Promise<boolean> {
  return withTx(async (client) => {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM instance WHERE id = $1 FOR UPDATE',
      [instanceId],
    );
    const inst = rows[0];
    if (!inst) return false;
    if (!['provisioning', 'lobby', 'running'].includes(inst.status)) return false;

    await client.query("UPDATE instance SET status = 'cancelled', ended_at = now() WHERE id = $1", [instanceId]);
    // Refund each still-held entry fee exactly once.
    await client.query(
      `INSERT INTO ledger (email, instance_id, type, amount)
       SELECT email, instance_id, 'hold_release', -amount
         FROM ledger
        WHERE instance_id = $1 AND type = 'entry_hold'`,
      [instanceId],
    );
    return true;
  });
}

/** Winner-takes-pot, rake 0 (ARCHITECTURE §5: SUM(payouts) <= -SUM(holds)). */
export function computePayouts(pot: number, ranking: string[]): Payout[] {
  if (pot <= 0 || ranking.length === 0) return [];
  return [{ email: ranking[0]!, amount: pot }];
}

function assertPayoutsSound(pot: number, payouts: Payout[]): void {
  let total = 0;
  for (const payout of payouts) {
    if (!Number.isInteger(payout.amount) || payout.amount <= 0) {
      throw new LedgerError('invalid_amount', 'payout amounts must be positive integers'); // L-04
    }
    total += payout.amount;
  }
  if (total > pot) throw new LedgerError('conservation', 'payouts exceed the pot'); // L-03
}

export type SettleResult =
  | { settled: true; alreadySettled: false; payouts: Payout[] }
  | { settled: false; alreadySettled: true; payouts: Payout[] };

async function settleInternal(
  instanceId: string,
  arg: { ranking?: string[]; payouts?: Payout[] },
): Promise<SettleResult> {
  return withTx(async (client) => {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM instance WHERE id = $1 FOR UPDATE',
      [instanceId],
    );
    const inst = rows[0];
    if (!inst) throw new LedgerError('not_found', 'instance not found');
    if (inst.status === 'finished') return { settled: false, alreadySettled: true, payouts: [] }; // L-01
    if (!['lobby', 'running'].includes(inst.status)) {
      throw new LedgerError('not_settleable', `cannot settle a ${inst.status} instance`); // L-02
    }

    const playerRows = await client.query<{ email: string }>(
      'SELECT email FROM instance_player WHERE instance_id = $1',
      [instanceId],
    );
    const players = new Set(playerRows.rows.map((r) => r.email));

    const potRow = await client.query<{ pot: number }>(
      "SELECT COALESCE(-SUM(amount), 0)::int AS pot FROM ledger WHERE instance_id = $1 AND type = 'entry_hold'",
      [instanceId],
    );
    const pot = potRow.rows[0]!.pot;

    let payouts: Payout[];
    if (arg.ranking) {
      const ranking = arg.ranking;
      if (ranking.length === 0) throw new LedgerError('invalid_ranking', 'ranking is empty');
      if (new Set(ranking).size !== ranking.length) throw new LedgerError('invalid_ranking', 'ranking has duplicates');
      for (const email of ranking) {
        if (!players.has(email)) throw new LedgerError('invalid_ranking', 'ranking includes a non-player'); // S-06
      }
      payouts = computePayouts(pot, ranking);
    } else {
      payouts = arg.payouts ?? [];
      for (const payout of payouts) {
        if (!players.has(payout.email)) throw new LedgerError('invalid_ranking', 'payout to a non-player');
      }
    }

    assertPayoutsSound(pot, payouts); // L-03, L-04 — before any write

    for (const payout of payouts) {
      await client.query("INSERT INTO ledger (email, instance_id, type, amount) VALUES ($1, $2, 'payout', $3)", [
        payout.email,
        instanceId,
        payout.amount,
      ]);
    }
    await client.query("UPDATE instance SET status = 'finished', ended_at = now() WHERE id = $1", [instanceId]);
    return { settled: true, alreadySettled: false, payouts };
  });
}

/** Settles from a ranking of players (endpoint path). Winner takes the pot. */
export function settleInstance(instanceId: string, ranking: string[]): Promise<SettleResult> {
  return settleInternal(instanceId, { ranking });
}

/** Settles from an explicit payout set (internal/tests): keeps the same guards. */
export function settleInstanceWithPayouts(instanceId: string, payouts: Payout[]): Promise<SettleResult> {
  return settleInternal(instanceId, { payouts });
}
