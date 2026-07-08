import { afterAll, describe, expect, it } from 'vitest';
import { verifyProvisionRequest } from '@hub/game-server-sdk';
import { pool } from '../helpers/db';
import {
  api,
  cleanupTestData,
  createSessionCookie,
  seedGameAndVersion,
  seedParticipant,
  testEmail,
} from '../helpers/hub';
import { startMockProvisioner } from '../helpers/mock-provisioner';

afterAll(async () => {
  await cleanupTestData();
  await pool.end();
});

async function approvedCreator(): Promise<string> {
  const email = testEmail('creator');
  await seedParticipant(email, 'approved');
  return createSessionCookie(email);
}

async function frontendUrlOf(instanceId: string): Promise<string | null> {
  const { rows } = await pool.query<{ frontend_url: string; server_url: string | null; status: string }>(
    `SELECT gv.frontend_url, i.server_url, i.status
       FROM instance i JOIN game_version gv ON gv.id = i.game_version_id
      WHERE i.id = $1`,
    [instanceId],
  );
  return rows[0]?.frontend_url ?? null;
}

async function latestInstanceStatus(createdBy: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM instance WHERE created_by = $1 ORDER BY created_at DESC LIMIT 1',
    [createdBy],
  );
  return rows[0]?.status;
}

describe('P — provisioning response handling (hub-side, invariants §9.1/§9.2/§9.8)', () => {
  it('P-03 a frontendUrl in the provision response is ignored; the hub keeps the registered URL', async () => {
    const secret = 'shared-secret-p03';
    const registeredFrontend = 'http://localhost:4000';
    const mock = await startMockProvisioner({
      kind: 'respond',
      body: { serverUrl: 'ws://localhost:9001', frontendUrl: 'http://evil.example/attacker' },
    });
    try {
      const { gameId } = await seedGameAndVersion(testEmail('host'), {
        provisionUrl: mock.url,
        frontendUrl: registeredFrontend,
        webhookSecret: secret,
      });
      const cookie = await approvedCreator();

      const res = await api('/api/instances', { cookie, body: { gameId } });
      expect(res.status).toBe(201);
      const { instanceId } = await res.json();

      // framed URL comes only from the registry, never the response
      expect(await frontendUrlOf(instanceId)).toBe(registeredFrontend);

      // and the hub really signed the outbound call with the game's secret
      const received = mock.received.at(-1)!;
      expect(
        verifyProvisionRequest({
          secret,
          timestamp: received.headers['x-hub-timestamp']!,
          signature: received.headers['x-hub-signature'],
          body: received.body,
        }),
      ).toEqual({ ok: true });
    } finally {
      await mock.close();
    }
  });

  it('P-04 a response naming an unregistered version fails creation and cancels the instance', async () => {
    const mock = await startMockProvisioner({
      kind: 'respond',
      body: { serverUrl: 'ws://localhost:9002', version: '9.9.9' },
    });
    try {
      const { gameId } = await seedGameAndVersion(testEmail('host'), { provisionUrl: mock.url });
      const cookie = await approvedCreator();
      const res = await api('/api/instances', { cookie, body: { gameId } });
      expect(res.status).toBe(502);

      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM instance WHERE game_version_id IN (SELECT id FROM game_version WHERE game_id = $1)',
        [gameId],
      );
      expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it('P-04 a response naming a revoked version also fails creation', async () => {
    const mock = await startMockProvisioner({
      kind: 'respond',
      body: { serverUrl: 'ws://localhost:9003', version: '2.0.0' },
    });
    try {
      const host = testEmail('host');
      const { gameId } = await seedGameAndVersion(host, { provisionUrl: mock.url });
      // register 2.0.0 then revoke it
      await pool.query(
        `INSERT INTO game_version (game_id, semver, frontend_url, provision_url, status)
         VALUES ($1, '2.0.0', 'http://localhost:4000', $2, 'revoked')`,
        [gameId, mock.url],
      );
      const cookie = await approvedCreator();
      const res = await api('/api/instances', { cookie, body: { gameId } });
      expect(res.status).toBe(502);
    } finally {
      await mock.close();
    }
  });

  it('P-06 a hanging provision endpoint times out; the instance is cancelled', async () => {
    const mock = await startMockProvisioner({ kind: 'hang' });
    try {
      const { gameId } = await seedGameAndVersion(testEmail('host'), { provisionUrl: mock.url });
      const creator = testEmail('creator');
      await seedParticipant(creator, 'approved');
      const cookie = await createSessionCookie(creator);

      const res = await api('/api/instances', { cookie, body: { gameId } });
      expect(res.status).toBe(502);
      expect((await res.json()).kind).toBe('timeout');
      expect(await latestInstanceStatus(creator)).toBe('cancelled');
    } finally {
      await mock.close();
    }
  }, 15_000);

  it('happy path: a well-behaved provisioner brings the instance to lobby with an opaque serverUrl', async () => {
    const mock = await startMockProvisioner({ kind: 'respond', body: { serverUrl: 'wss://game.example/abc' } });
    try {
      const { gameId } = await seedGameAndVersion(testEmail('host'), { provisionUrl: mock.url });
      const cookie = await approvedCreator();
      const res = await api('/api/instances', { cookie, body: { gameId } });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.status).toBe('lobby');
      expect(data.inviteCode).toMatch(/^[A-Z0-9]+$/);

      const { rows } = await pool.query<{ server_url: string; status: string }>(
        'SELECT server_url, status FROM instance WHERE id = $1',
        [data.instanceId],
      );
      expect(rows[0]).toEqual({ server_url: 'wss://game.example/abc', status: 'lobby' });
    } finally {
      await mock.close();
    }
  });
});
