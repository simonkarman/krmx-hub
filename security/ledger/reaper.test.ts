import { afterAll, describe, expect, it } from 'vitest';
import { REAPER_STALE_AFTER_MS, reapStaleInstances } from '../../apps/hub/src/lib/reaper';
import { pool as hubPool } from '../../apps/hub/src/lib/db';
import { pool } from '../helpers/db';
import {
  cleanupTestData,
  HUB_URL,
  newServiceToken,
  seedGameAndVersion,
  seedInstance,
  seedParticipant,
  testEmail,
} from '../helpers/hub';

afterAll(async () => {
  await cleanupTestData();
  await hubPool.end();
  await pool.end();
});

async function heartbeat(instanceId: string, token: string): Promise<Response> {
  return fetch(`${HUB_URL}/api/service/instances/${instanceId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'running' }),
  });
}

describe('L-09 — reaper on a dead server (token/cancel part; hold release lands in M4)', () => {
  it('L-09 cancels a stale instance and revokes its service token', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'));
    const creator = testEmail('creator');
    await seedParticipant(creator, 'approved');
    const { token } = newServiceToken();

    const stale = new Date(Date.now() - REAPER_STALE_AFTER_MS - 60_000);
    const instanceId = await seedInstance({
      versionId,
      createdBy: creator,
      status: 'running',
      serviceToken: token,
      lastHeartbeatAt: stale,
    });
    // the creator staked an entry fee that the reaper must refund
    await pool.query("INSERT INTO ledger (email, instance_id, type, amount) VALUES ($1, $2, 'entry_hold', -10)", [
      creator,
      instanceId,
    ]);

    // token works while the instance is alive
    expect((await heartbeat(instanceId, token)).status).toBe(200);
    // but that heartbeat just refreshed last_heartbeat_at — push it back again
    await pool.query('UPDATE instance SET last_heartbeat_at = $2 WHERE id = $1', [instanceId, stale]);

    const reaped = await reapStaleInstances();
    expect(reaped).toContain(instanceId);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM instance WHERE id = $1', [instanceId]);
    expect(rows[0]!.status).toBe('cancelled');

    // hold released: the fee is refunded exactly once (§8, L-09 completion)
    const release = await pool.query<{ n: number; s: number }>(
      "SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::int AS s FROM ledger WHERE instance_id = $1 AND type = 'hold_release'",
      [instanceId],
    );
    expect(release.rows[0]!.n).toBe(1);
    expect(release.rows[0]!.s).toBe(10);

    // token revoked by the terminal status
    expect((await heartbeat(instanceId, token)).status).toBe(401);
  });

  it('leaves fresh instances alone', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'));
    const creator = testEmail('creator');
    await seedParticipant(creator, 'approved');
    const fresh = await seedInstance({
      versionId,
      createdBy: creator,
      status: 'running',
      lastHeartbeatAt: new Date(),
    });

    const reaped = await reapStaleInstances();
    expect(reaped).not.toContain(fresh);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM instance WHERE id = $1', [fresh]);
    expect(rows[0]!.status).toBe('running');
  });
});
