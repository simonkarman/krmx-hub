import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { pool as hubPool } from '../../apps/hub/src/lib/db';
import { grantCredits } from '../../apps/hub/src/lib/participants';
import {
  cancelInstance,
  joinInstance,
  LedgerError,
  reserveInstance,
  settleInstance,
  settleInstanceWithPayouts,
} from '../../apps/hub/src/lib/ledger';
import { pool } from '../helpers/db';
import { cleanupTestData, seedGameAndVersion, seedParticipant, testEmail } from '../helpers/hub';

afterAll(async () => {
  await cleanupTestData();
  await hubPool.end();
  await pool.end();
});

const ENTRY_FEE = 10;

async function balance(email: string): Promise<number> {
  const { rows } = await pool.query<{ b: number }>(
    'SELECT COALESCE(SUM(amount),0)::int AS b FROM ledger WHERE email = $1',
    [email],
  );
  return rows[0]!.b;
}

async function countRows(instanceId: string, type: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM ledger WHERE instance_id = $1 AND type = $2',
    [instanceId, type],
  );
  return rows[0]!.n;
}

async function statusOf(instanceId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM instance WHERE id = $1', [instanceId]);
  return rows[0]!.status;
}

/** Reserve an instance (seats creator + holds) and mark it lobby, as a successful provision would. */
async function reserveLobby(versionId: number, creator: string, entryFee = ENTRY_FEE): Promise<string> {
  const instanceId = `inst-${randomUUID().slice(0, 12)}`;
  await reserveInstance({
    instanceId,
    gameVersionId: versionId,
    createdBy: creator,
    visibility: 'private',
    serviceTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    entryFee,
  });
  await pool.query("UPDATE instance SET status = 'lobby' WHERE id = $1", [instanceId]);
  return instanceId;
}

async function approvedFunded(prefix: string, credits = 100): Promise<string> {
  const email = testEmail(prefix);
  await seedParticipant(email, 'approved');
  if (credits > 0) await grantCredits(email, credits);
  return email;
}

describe('L — ledger integrity (direct, real Postgres transactions)', () => {
  it('L-05 double-join yields one hold and one player row', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: ENTRY_FEE, maxPlayers: 3 });
    const creator = await approvedFunded('creator');
    const joiner = await approvedFunded('joiner');
    const instanceId = await reserveLobby(versionId, creator);

    const first = await joinInstance(instanceId, joiner);
    const second = await joinInstance(instanceId, joiner);
    expect(first.alreadyMember).toBe(false);
    expect(second.alreadyMember).toBe(true);

    const players = await pool.query('SELECT 1 FROM instance_player WHERE instance_id = $1 AND email = $2', [
      instanceId,
      joiner,
    ]);
    expect(players.rowCount).toBe(1);
    expect(await countRows(instanceId, 'entry_hold')).toBe(2); // creator + joiner, once each
    expect(await balance(joiner)).toBe(100 - ENTRY_FEE);
  });

  it('L-06 concurrent joins racing the last credit: at most one succeeds, balance never < 0', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: ENTRY_FEE, maxPlayers: 5 });
    const creator = await approvedFunded('creator');
    const a = await reserveLobby(versionId, creator);
    const b = await reserveLobby(versionId, creator);

    // exactly enough for a single entry fee
    const racer = testEmail('racer');
    await seedParticipant(racer, 'approved');
    await grantCredits(racer, ENTRY_FEE);

    const results = await Promise.allSettled([joinInstance(a, racer), joinInstance(b, racer)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LedgerError);
    expect(await balance(racer)).toBe(0);
    expect(await balance(racer)).toBeGreaterThanOrEqual(0);
  });

  it('L-01 double-settle is idempotent: payouts written once', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: ENTRY_FEE, maxPlayers: 2 });
    const p1 = await approvedFunded('p1');
    const p2 = await approvedFunded('p2');
    const instanceId = await reserveLobby(versionId, p1);
    await joinInstance(instanceId, p2);

    const first = await settleInstance(instanceId, [p1]);
    expect(first.settled).toBe(true);
    const second = await settleInstance(instanceId, [p1]);
    expect(second).toMatchObject({ settled: false, alreadySettled: true });

    expect(await countRows(instanceId, 'payout')).toBe(1);
    // winner p1: 100 - 10 (hold) + 20 (pot) = 110; loser p2: 100 - 10 = 90; conserved
    expect(await balance(p1)).toBe(110);
    expect(await balance(p2)).toBe(90);
  });

  it('L-02 settle after cancel and cancel after settle are both refused (one terminal transition)', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: ENTRY_FEE, maxPlayers: 2 });

    // cancel, then settle
    const p1 = await approvedFunded('p1');
    const cancelled = await reserveLobby(versionId, p1);
    expect(await cancelInstance(cancelled)).toBe(true);
    await expect(settleInstance(cancelled, [p1])).rejects.toMatchObject({ code: 'not_settleable' });
    expect(await countRows(cancelled, 'hold_release')).toBe(1);
    expect(await countRows(cancelled, 'payout')).toBe(0);
    expect(await balance(p1)).toBe(100); // fully refunded

    // settle, then cancel
    const p2 = await approvedFunded('p2');
    const settled = await reserveLobby(versionId, p2);
    await settleInstance(settled, [p2]);
    expect(await cancelInstance(settled)).toBe(false); // no-op
    expect(await countRows(settled, 'hold_release')).toBe(0);
    expect(await statusOf(settled)).toBe('finished');
  });

  it('L-03 payouts exceeding the pot are rejected atomically', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: ENTRY_FEE, maxPlayers: 2 });
    const p1 = await approvedFunded('p1');
    const p2 = await approvedFunded('p2');
    const instanceId = await reserveLobby(versionId, p1);
    await joinInstance(instanceId, p2);

    // pot is 20; try to pay out 21
    await expect(settleInstanceWithPayouts(instanceId, [{ email: p1, amount: 21 }])).rejects.toMatchObject({
      code: 'conservation',
    });
    expect(await countRows(instanceId, 'payout')).toBe(0);
    expect(await statusOf(instanceId)).toBe('lobby'); // untouched
  });

  it('L-04 non-positive or non-integer payout amounts are rejected', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: ENTRY_FEE, maxPlayers: 2 });
    const p1 = await approvedFunded('p1');
    const p2 = await approvedFunded('p2');
    const instanceId = await reserveLobby(versionId, p1);
    await joinInstance(instanceId, p2);

    for (const amount of [0, -5, 3.5]) {
      await expect(settleInstanceWithPayouts(instanceId, [{ email: p1, amount }])).rejects.toMatchObject({
        code: 'invalid_amount',
      });
    }
    expect(await countRows(instanceId, 'payout')).toBe(0);
    expect(await statusOf(instanceId)).toBe('lobby');
  });

  it('L-07 concurrent settle + reap: exactly one wins; holds captured XOR released', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: ENTRY_FEE, maxPlayers: 2 });
    const p1 = await approvedFunded('p1');
    const p2 = await approvedFunded('p2');
    const instanceId = await reserveLobby(versionId, p1);
    await joinInstance(instanceId, p2);

    const [settleRes, cancelRes] = await Promise.allSettled([
      settleInstance(instanceId, [p1]),
      cancelInstance(instanceId),
    ]);

    const status = await statusOf(instanceId);
    const payouts = await countRows(instanceId, 'payout');
    const releases = await countRows(instanceId, 'hold_release');

    // exactly one terminal outcome, and holds resolved exactly one way
    if (status === 'finished') {
      expect(payouts).toBe(1);
      expect(releases).toBe(0);
      expect(await balance(p1)).toBe(110);
    } else {
      expect(status).toBe('cancelled');
      expect(payouts).toBe(0);
      expect(releases).toBe(2); // both holds refunded
      expect(await balance(p1)).toBe(100);
      expect(await balance(p2)).toBe(100);
    }
    // both operations completed without throwing an unexpected error
    for (const r of [settleRes, cancelRes]) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LedgerError);
    }
  });

  it('L-10 only ledger.ts and participants.ts write ledger rows (route audit)', () => {
    const hubSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/hub/src');
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && /INSERT\s+INTO\s+ledger/i.test(readFileSync(full, 'utf8'))) {
          writers.push(path.relative(hubSrc, full));
        }
      }
    };
    walk(hubSrc);
    expect(writers.sort()).toEqual(['lib/ledger.ts', 'lib/participants.ts']);
  });
});
