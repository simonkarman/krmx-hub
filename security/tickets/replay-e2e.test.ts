import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from '@krmx/server';
import { createClient } from '@krmx/client';
import { useHubAuthentication } from '@hub/krmx-adapter';
import { pool } from '../helpers/db';
import {
  addInstancePlayer,
  api,
  cleanupTestData,
  createSessionCookie,
  HUB_URL,
  seedGameAndVersion,
  seedInstance,
  seedParticipant,
  testEmail,
  testUsername,
} from '../helpers/hub';

const servers: Server[] = [];

afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  await cleanupTestData();
  await pool.end();
});

function linkOutcome(client: ReturnType<typeof createClient>): Promise<'accept' | 'reject'> {
  return new Promise((resolve) => {
    client.on('accept', () => resolve('accept'));
    client.on('reject', () => resolve('reject'));
  });
}

describe('T-08 end-to-end — single-use ticket through the real Krmx server + adapter', () => {
  it('T-08 a ticket links once; replaying it on a second connection is rejected (jti)', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'));
    const player = testEmail('player');
    await seedParticipant(player, 'approved', [], testUsername('p')); // Krmx-valid username
    const instanceId = await seedInstance({ versionId, createdBy: player, status: 'lobby' });
    await addInstancePlayer(instanceId, player);

    // Real game server with the hub adapter wired into authenticate.
    const server = createServer({ logger: false });
    servers.push(server);
    useHubAuthentication(server, { hubUrl: HUB_URL, instanceId });
    const port = await server.listen(0);

    // Mint one real ticket via the hub.
    const cookie = await createSessionCookie(player);
    const res = await api(`/api/instances/${instanceId}/ticket`, { cookie });
    expect(res.status).toBe(200);
    const { ticket, username } = await res.json();

    // First link is accepted; then fully unlink + disconnect so the second
    // attempt can only fail on jti replay, not on "already linked".
    const c1 = createClient({ logger: false });
    await c1.connect(`ws://localhost:${port}`);
    const first = linkOutcome(c1);
    await c1.link(username, ticket).catch(() => {});
    expect(await first).toBe('accept');
    await c1.unlink().catch(() => {});
    await c1.disconnect(true).catch(() => {});

    // Same ticket, fresh connection → rejected by the verifier's jti seen-set.
    const c2 = createClient({ logger: false });
    await c2.connect(`ws://localhost:${port}`);
    const second = linkOutcome(c2);
    await c2.link(username, ticket).catch(() => {});
    expect(await second).toBe('reject');
    await c2.disconnect(true).catch(() => {});
  });

  it('a fresh ticket for the same instance still links (the seen-set only blocks reuse)', async () => {
    const { versionId } = await seedGameAndVersion(testEmail('host'));
    const player = testEmail('player');
    await seedParticipant(player, 'approved', [], testUsername('p')); // Krmx-valid username
    const instanceId = await seedInstance({ versionId, createdBy: player, status: 'lobby' });
    await addInstancePlayer(instanceId, player);

    const server = createServer({ logger: false });
    servers.push(server);
    useHubAuthentication(server, { hubUrl: HUB_URL, instanceId });
    const port = await server.listen(0);
    const cookie = await createSessionCookie(player);

    const mint = async () => {
      const { ticket, username } = await (await api(`/api/instances/${instanceId}/ticket`, { cookie })).json();
      return { ticket, username } as { ticket: string; username: string };
    };

    const c1 = createClient({ logger: false });
    await c1.connect(`ws://localhost:${port}`);
    const first = linkOutcome(c1);
    const t1 = await mint();
    await c1.link(t1.username, t1.ticket).catch(() => {});
    expect(await first).toBe('accept');
    await c1.unlink().catch(() => {});
    await c1.disconnect(true).catch(() => {});

    const c2 = createClient({ logger: false });
    await c2.connect(`ws://localhost:${port}`);
    const second = linkOutcome(c2);
    const t2 = await mint(); // different jti
    await c2.link(t2.username, t2.ticket).catch(() => {});
    expect(await second).toBe('accept');
    await c2.disconnect(true).catch(() => {});
  });
});
