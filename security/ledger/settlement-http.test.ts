import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../helpers/db';
import {
  addInstancePlayer,
  api,
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

async function grant(email: string, amount: number): Promise<void> {
  await pool.query("INSERT INTO ledger (email, type, amount) VALUES ($1, 'grant', $2)", [email, amount]);
}
async function hold(email: string, instanceId: string, fee: number): Promise<void> {
  await pool.query("INSERT INTO ledger (email, instance_id, type, amount) VALUES ($1, $2, 'entry_hold', $3)", [
    email,
    instanceId,
    -fee,
  ]);
}
function results(instanceId: string, token: string | undefined, ranking: unknown): Promise<Response> {
  return fetch(`${HUB_URL}/api/service/instances/${instanceId}/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ranking }),
  });
}
async function payoutCount(instanceId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM ledger WHERE instance_id = $1 AND type = 'payout'",
    [instanceId],
  );
  return rows[0]!.n;
}

/** A running instance with two seated players holding an entry fee and a known token. */
async function runningInstance(fee = 10): Promise<{ id: string; token: string; p1: string; p2: string }> {
  const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: fee, maxPlayers: 2 });
  const p1 = testEmail('p1');
  const p2 = testEmail('p2');
  await seedParticipant(p1, 'approved');
  await seedParticipant(p2, 'approved');
  await grant(p1, 100);
  await grant(p2, 100);
  const { token } = newServiceToken();
  const id = await seedInstance({ versionId, createdBy: p1, status: 'running', serviceToken: token });
  await addInstancePlayer(id, p1);
  await addInstancePlayer(id, p2);
  await hold(p1, id, fee);
  await hold(p2, id, fee);
  return { id, token, p1, p2 };
}

describe('results / settlement endpoint (M4)', () => {
  it('S-06 a ranking with a non-player email is rejected with no ledger writes', async () => {
    const { id, token } = await runningInstance();
    const outsider = testEmail('outsider');
    await seedParticipant(outsider, 'approved');

    const res = await results(id, token, [outsider]);
    expect(res.status).toBe(400);
    expect(await payoutCount(id)).toBe(0);
    // instance not settled
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM instance WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('running');
  });

  it('settles a valid ranking (winner takes the pot) and marks finished', async () => {
    const { id, token, p1, p2 } = await runningInstance();
    const res = await results(id, token, [p1, p2]);
    expect(res.status).toBe(200);
    expect((await res.json()).payouts).toEqual([{ email: p1, amount: 20 }]);

    const bal = async (e: string) =>
      (await pool.query<{ b: number }>('SELECT COALESCE(SUM(amount),0)::int AS b FROM ledger WHERE email=$1', [e]))
        .rows[0]!.b;
    expect(await bal(p1)).toBe(110);
    expect(await bal(p2)).toBe(90);
  });

  it('L-01 a replayed results call is rejected: the token is revoked once finished', async () => {
    const { id, token, p1 } = await runningInstance();
    expect((await results(id, token, [p1])).status).toBe(200);
    // second call with the same (now revoked) token
    expect((await results(id, token, [p1])).status).toBe(401);
    expect(await payoutCount(id)).toBe(1);
  });

  it('rejects an empty ranking and a bad body (400)', async () => {
    const { id, token } = await runningInstance();
    expect((await results(id, token, [])).status).toBe(400);
    const raw = await fetch(`${HUB_URL}/api/service/instances/${id}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ notRanking: true }),
    });
    expect(raw.status).toBe(400);
  });

  it('requires a valid service token for this instance (S-05-style)', async () => {
    const { id } = await runningInstance();
    expect((await results(id, undefined, ['x'])).status).toBe(401);
    expect((await results(id, newServiceToken().token, ['x'])).status).toBe(401);
  });
});

describe('join endpoint (M4)', () => {
  async function lobbyInstance(fee = 0, maxPlayers = 2): Promise<{ id: string; versionId: number }> {
    const { versionId } = await seedGameAndVersion(testEmail('host'), { entryFee: fee, maxPlayers });
    const creator = testEmail('creator');
    await seedParticipant(creator, 'approved');
    const id = await seedInstance({ versionId, createdBy: creator, status: 'lobby' });
    await addInstancePlayer(id, creator);
    return { id, versionId };
  }

  it('an approved user joins a lobby (idempotently)', async () => {
    const { id } = await lobbyInstance(0, 4);
    const user = testEmail('joiner');
    await seedParticipant(user, 'approved');
    const cookie = await createSessionCookie(user);

    const first = await api(`/api/instances/${id}/join`, { cookie, body: {} });
    expect(first.status).toBe(200);
    expect((await first.json()).alreadyMember).toBe(false);
    const second = await api(`/api/instances/${id}/join`, { cookie, body: {} });
    expect((await second.json()).alreadyMember).toBe(true);
  });

  it('a pending user cannot join (403)', async () => {
    const { id } = await lobbyInstance();
    const user = testEmail('pending');
    await seedParticipant(user, 'pending');
    const cookie = await createSessionCookie(user);
    expect((await api(`/api/instances/${id}/join`, { cookie, body: {} })).status).toBe(403);
  });

  it('joining a full instance is rejected (409)', async () => {
    const { id } = await lobbyInstance(0, 1); // creator already fills the single seat
    const user = testEmail('latecomer');
    await seedParticipant(user, 'approved');
    const cookie = await createSessionCookie(user);
    expect((await api(`/api/instances/${id}/join`, { cookie, body: {} })).status).toBe(409);
  });

  it('an underfunded user cannot join a paid game (402)', async () => {
    const { id } = await lobbyInstance(50, 4);
    const user = testEmail('broke');
    await seedParticipant(user, 'approved'); // no credits granted
    const cookie = await createSessionCookie(user);
    expect((await api(`/api/instances/${id}/join`, { cookie, body: {} })).status).toBe(402);
  });
});
