import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../helpers/db';
import { api, cleanupTestData, createSessionCookie, seedGameAndVersion, seedParticipant, testEmail } from '../helpers/hub';

afterAll(async () => {
  await cleanupTestData();
  await pool.end();
});

describe('A — registry authorization', () => {
  it('A-06 a non-host cannot register a game or a version (403)', async () => {
    const user = testEmail('plain-user');
    await seedParticipant(user, 'approved'); // approved but no host role
    const cookie = await createSessionCookie(user);

    expect((await api('/api/games', { cookie, body: { id: 'nope-game', name: 'Nope' } })).status).toBe(403);

    // even against an existing game, a non-host is refused
    const { gameId } = await seedGameAndVersion(testEmail('host'));
    expect(
      (await api(`/api/games/${gameId}/versions`, { cookie, body: { semver: '1.2.3', frontendUrl: 'http://localhost:4000', provisionUrl: 'http://localhost:4100/provision' } }))
        .status,
    ).toBe(403);
  });

  it('A-07 host A cannot edit host B\'s game/version (403)', async () => {
    const { gameId } = await seedGameAndVersion(testEmail('host-b'));

    const hostA = testEmail('host-a');
    await seedParticipant(hostA, 'approved', ['host']);
    const cookie = await createSessionCookie(hostA);

    expect(
      (await api(`/api/games/${gameId}/versions`, { cookie, body: { semver: '3.0.0', frontendUrl: 'http://localhost:4000', provisionUrl: 'http://localhost:4100/provision' } }))
        .status,
    ).toBe(403);
    expect((await api(`/api/games/${gameId}/publish`, { cookie, body: {} })).status).toBe(403);

    // nothing was created
    const { rows } = await pool.query('SELECT semver FROM game_version WHERE game_id = $1', [gameId]);
    expect(rows.map((r) => r.semver)).toEqual(['1.0.0']);
  });

  it('a host CAN register and publish their own game and version (positive control)', async () => {
    const host = testEmail('owner');
    await seedParticipant(host, 'approved', ['host']);
    const cookie = await createSessionCookie(host);
    const gameId = `owned-${Date.now()}`;

    const create = await api('/api/games', { cookie, body: { id: gameId, name: 'Owned', entryFee: 5 } });
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(typeof created.webhookSecret).toBe('string');
    expect(created.webhookSecret.length).toBeGreaterThan(0);

    const version = await api(`/api/games/${gameId}/versions`, {
      cookie,
      body: { semver: '1.0.0', frontendUrl: 'http://localhost:4000', provisionUrl: 'http://localhost:4100/provision' },
    });
    expect(version.status).toBe(201);

    expect((await api(`/api/games/${gameId}/publish`, { cookie, body: {} })).status).toBe(200);

    // published games appear in the public catalog
    const catalog = await (await api('/api/games')).json();
    expect(catalog.games.some((g: { id: string }) => g.id === gameId)).toBe(true);
    // and the catalog never leaks the webhook secret
    expect(JSON.stringify(catalog)).not.toContain(created.webhookSecret);

    await pool.query('DELETE FROM game_version WHERE game_id = $1', [gameId]);
    await pool.query('DELETE FROM game WHERE id = $1', [gameId]);
  });
});
