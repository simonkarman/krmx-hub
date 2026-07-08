import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { pool as hubPool } from '../../apps/hub/src/lib/db';
import { grantCredits } from '../../apps/hub/src/lib/participants';
import { cancelInstance, joinInstance, LedgerError, reserveInstance, settleInstance } from '../../apps/hub/src/lib/ledger';
import { pool } from '../helpers/db';
import { cleanupTestData, seedGameAndVersion, seedParticipant, testEmail } from '../helpers/hub';

const ENTRY_FEE = 10;
let versionId: number;

beforeAll(async () => {
  ({ versionId } = await seedGameAndVersion(testEmail('prop-host'), { entryFee: ENTRY_FEE, maxPlayers: 8 }));
});

afterAll(async () => {
  await cleanupTestData();
  await hubPool.end();
  await pool.end();
});

type Op =
  | { t: 'grant'; u: number; amt: number }
  | { t: 'create'; u: number }
  | { t: 'join'; u: number; inst: number }
  | { t: 'cancel'; inst: number }
  | { t: 'settle'; inst: number; w: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('grant' as const), u: fc.integer({ min: 0, max: 2 }), amt: fc.integer({ min: 1, max: 30 }) }),
  fc.record({ t: fc.constant('create' as const), u: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ t: fc.constant('join' as const), u: fc.integer({ min: 0, max: 2 }), inst: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ t: fc.constant('cancel' as const), inst: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ t: fc.constant('settle' as const), inst: fc.integer({ min: 0, max: 3 }), w: fc.integer({ min: 0, max: 2 }) }),
);

async function sumLedger(where: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ s: number }>(
    `SELECT COALESCE(SUM(amount),0)::int AS s FROM ledger WHERE ${where}`,
    params,
  );
  return rows[0]!.s;
}
async function count(instanceId: string, type: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM ledger WHERE instance_id = $1 AND type = $2',
    [instanceId, type],
  );
  return rows[0]!.n;
}

/** Invariants that must hold after every operation (ARCHITECTURE §5). */
async function checkInvariants(users: string[], instances: string[]): Promise<void> {
  for (const user of users) {
    const balance = await sumLedger('email = $1', [user]);
    expect(balance, `balance of ${user} must be >= 0`).toBeGreaterThanOrEqual(0);
  }
  for (const id of instances) {
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM instance WHERE id = $1', [id]);
    const status = rows[0]?.status;
    if (!status) continue;
    const holds = -(await sumLedger("instance_id = $1 AND type = 'entry_hold'", [id])); // pot (positive)
    const releasedSum = await sumLedger("instance_id = $1 AND type = 'hold_release'", [id]);
    const payoutSum = await sumLedger("instance_id = $1 AND type = 'payout'", [id]);
    const holdCount = await count(id, 'entry_hold');
    const releaseCount = await count(id, 'hold_release');

    if (status === 'finished') {
      expect(releaseCount, `${id} finished: no releases`).toBe(0);
      expect(payoutSum, `${id} finished: conservation`).toBeLessThanOrEqual(holds);
      expect(payoutSum).toBeGreaterThanOrEqual(0);
    } else if (status === 'cancelled') {
      expect(payoutSum, `${id} cancelled: no payouts`).toBe(0);
      expect(releaseCount, `${id} cancelled: one release per hold`).toBe(holdCount);
      expect(releasedSum, `${id} cancelled: holds fully refunded`).toBe(holds);
    } else {
      // active: holds pending, nothing resolved yet
      expect(payoutSum, `${id} active: no payouts`).toBe(0);
      expect(releaseCount, `${id} active: no releases`).toBe(0);
    }
  }
}

describe('L-08 — random interleavings preserve the ledger invariants (property)', () => {
  it('L-08 balance >= 0, every hold resolved once, per-instance conservation', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 16 }), async (ops) => {
        const runId = randomUUID().slice(0, 8);
        const users = [0, 1, 2].map((i) => `prop-${runId}-u${i}@sec-test.local`);
        for (const u of users) await seedParticipant(u, 'approved');
        const instances: string[] = [];

        for (const op of ops) {
          try {
            if (op.t === 'grant') {
              await grantCredits(users[op.u]!, op.amt);
            } else if (op.t === 'create') {
              const id = `inst-${runId}-${instances.length}`;
              await reserveInstance({
                instanceId: id,
                gameVersionId: versionId,
                createdBy: users[op.u]!,
                visibility: 'private',
                serviceTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
                entryFee: ENTRY_FEE,
              });
              await pool.query("UPDATE instance SET status = 'lobby' WHERE id = $1", [id]);
              instances.push(id);
            } else if (op.t === 'join' && instances[op.inst]) {
              await joinInstance(instances[op.inst]!, users[op.u]!);
            } else if (op.t === 'cancel' && instances[op.inst]) {
              await cancelInstance(instances[op.inst]!);
            } else if (op.t === 'settle' && instances[op.inst]) {
              await settleInstance(instances[op.inst]!, [users[op.w]!]);
            }
          } catch (error) {
            // Rejections (insufficient balance, full, non-player, terminal) are
            // expected; only a non-ledger error is a real failure.
            if (!(error instanceof LedgerError)) throw error;
          }
          await checkInvariants(users, instances);
        }

        // End state: resolve everything still active, then the whole system must
        // conserve — total credits held by these users equals total granted.
        for (const id of instances) await cancelInstance(id);
        await checkInvariants(users, instances);
        const totalBalance = await sumLedger('email = ANY($1)', [users]);
        const totalGranted = await sumLedger("email = ANY($1) AND type = 'grant'", [users]);
        expect(totalBalance).toBe(totalGranted);
      }),
      { numRuns: 30 },
    );
  }, 90_000);
});
