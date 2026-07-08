import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../helpers/db';
import {
  cleanupTestData,
  createSessionCookie,
  HUB_URL,
  newServiceToken,
  seedGameAndVersion,
  seedInstance,
  seedParticipant,
  testEmail,
} from '../helpers/hub';

afterAll(async () => {
  await cleanupTestData();
  await pool.end();
});

function heartbeat(
  instanceId: string,
  opts: { token?: string; header?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.header ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return fetch(`${HUB_URL}/api/service/instances/${instanceId}/heartbeat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? { status: 'running' }),
  });
}

async function seedTokenInstance(status: 'lobby' | 'running' | 'finished' | 'cancelled' = 'running'): Promise<{
  id: string;
  token: string;
  versionId: number;
}> {
  const { versionId } = await seedGameAndVersion(testEmail('host'));
  const creator = testEmail('creator');
  await seedParticipant(creator, 'approved');
  const { token } = newServiceToken();
  const id = await seedInstance({ versionId, createdBy: creator, status, serviceToken: token });
  return { id, token, versionId };
}

describe('S — service tokens', () => {
  it('happy path: an instance\'s own live token is accepted and records a heartbeat', async () => {
    const { id, token } = await seedTokenInstance('lobby');
    const res = await heartbeat(id, { token, body: { status: 'running' } });
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ status: string; last_heartbeat_at: Date | null }>(
      'SELECT status, last_heartbeat_at FROM instance WHERE id = $1',
      [id],
    );
    expect(rows[0]!.status).toBe('running');
    expect(rows[0]!.last_heartbeat_at).not.toBeNull();
  });

  it("S-01 instance A's token on instance B's heartbeat is 403", async () => {
    const a = await seedTokenInstance();
    const b = await seedTokenInstance();
    expect((await heartbeat(b.id, { token: a.token })).status).toBe(403);
  });

  it('S-02 a token after settlement (finished) is 401 (revoked)', async () => {
    const { id, token } = await seedTokenInstance('finished');
    expect((await heartbeat(id, { token })).status).toBe(401);
  });

  it('S-03 a token after reaper cancellation is 401 (revoked)', async () => {
    const { id, token } = await seedTokenInstance('cancelled');
    expect((await heartbeat(id, { token })).status).toBe(401);
  });

  it('S-04 a random or tampered token is 401', async () => {
    const { id, token } = await seedTokenInstance();
    expect((await heartbeat(id, { token: newServiceToken().token })).status).toBe(401);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect((await heartbeat(id, { token: tampered })).status).toBe(401);
    expect((await heartbeat(id, {})).status).toBe(401); // no token at all
  });

  it('S-05 a service token is worthless on user/admin routes and ticket minting (401)', async () => {
    const { id, token } = await seedTokenInstance();
    const bearer = { authorization: `Bearer ${token}` };
    for (const path of ['/api/admin/participants', `/api/instances/${id}/ticket`]) {
      expect((await fetch(`${HUB_URL}${path}`, { headers: bearer })).status).toBe(401);
    }
  });

  it('S-07 the token is accepted only via the Authorization header, never a query param', async () => {
    const { id, token } = await seedTokenInstance();
    // query param must not authenticate
    const viaQuery = await fetch(`${HUB_URL}/api/service/instances/${id}/heartbeat?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });
    expect(viaQuery.status).toBe(401);
    // same token via header works
    expect((await heartbeat(id, { token })).status).toBe(200);
  });

  it('malformed heartbeat body (bad status) is 400 even with a valid token', async () => {
    const { id, token } = await seedTokenInstance();
    expect((await heartbeat(id, { token, body: { status: 'over' } })).status).toBe(400);
  });
});
