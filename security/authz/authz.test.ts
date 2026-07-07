import { afterAll, describe, expect, it } from 'vitest';
import { AuthzError, requireApproved } from '../../apps/hub/src/lib/authz';
import type { Participant } from '../../apps/hub/src/lib/participants';
import { pool } from '../helpers/db';
import { api, cleanupTestData, createSessionCookie, HUB_URL, seedParticipant, testEmail } from '../helpers/hub';

afterAll(async () => {
  await cleanupTestData();
  await pool.end();
});

async function loadParticipant(email: string): Promise<Participant> {
  const { rows } = await pool.query('SELECT * FROM participant WHERE email = $1', [email]);
  const row = rows[0];
  if (!row) throw new Error('participant not seeded');
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

describe('A — hub API authorization', () => {
  it('A-01 pending user: the approval gate rejects with 403 (create/join/ticket reuse this gate in M2/M3)', async () => {
    const email = testEmail('pending');
    await seedParticipant(email, 'pending');
    const pending = await loadParticipant(email);

    let thrown: unknown;
    try {
      requireApproved(pending);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuthzError);
    expect((thrown as AuthzError).status).toBe(403);

    // sanity: the same gate passes an approved participant
    await seedParticipant(email, 'approved');
    expect(requireApproved(await loadParticipant(email)).email).toBe(email);
  });

  it('A-02 blocked user with a still-live session: any gated route responds 403', async () => {
    // blocked wins even over a held admin role
    const email = testEmail('blocked-admin');
    await seedParticipant(email, 'blocked', ['admin']);
    const cookie = await createSessionCookie(email);

    const target = testEmail('a02-target');
    await seedParticipant(target, 'pending');

    expect((await api('/api/admin/participants', { cookie })).status).toBe(403);
    expect(
      (await api(`/api/admin/participants/${encodeURIComponent(target)}/status`, { cookie, body: { status: 'approved' } }))
        .status,
    ).toBe(403);
    expect(
      (await api(`/api/admin/participants/${encodeURIComponent(target)}/credits`, { cookie, body: { amount: 100 } }))
        .status,
    ).toBe(403);
  });

  it('A-05 non-admin calls approve/roles/grant endpoints directly (bypassing UI): 403 and no side effects', async () => {
    const email = testEmail('approved-user');
    await seedParticipant(email, 'approved');
    const cookie = await createSessionCookie(email);

    const target = testEmail('a05-target');
    await seedParticipant(target, 'pending');
    const base = `/api/admin/participants/${encodeURIComponent(target)}`;

    expect((await api('/api/admin/participants', { cookie })).status).toBe(403);
    expect((await api(`${base}/status`, { cookie, body: { status: 'approved' } })).status).toBe(403);
    expect((await api(`${base}/roles`, { cookie, body: { role: 'admin', op: 'grant' } })).status).toBe(403);
    expect((await api(`${base}/credits`, { cookie, body: { amount: 1000 } })).status).toBe(403);

    const after = await loadParticipant(target);
    expect(after.status).toBe('pending');
    expect(after.roles).toEqual([]);
    const { rows } = await pool.query('SELECT * FROM ledger WHERE email = $1', [target]);
    expect(rows).toEqual([]);
  });

  it('A-08 anonymous: catalog readable; everything else 401', async () => {
    const home = await fetch(`${HUB_URL}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Krmx Hub');

    expect((await api('/api/admin/participants')).status).toBe(401);
    expect((await api('/api/admin/participants/x%40y.z/status', { body: { status: 'approved' } })).status).toBe(401);
    expect((await api('/api/admin/participants/x%40y.z/roles', { body: { role: 'host', op: 'grant' } })).status).toBe(401);
    expect((await api('/api/admin/participants/x%40y.z/credits', { body: { amount: 1 } })).status).toBe(401);

    // the admin page itself never renders for anonymous visitors
    const adminPage = await fetch(`${HUB_URL}/admin`, { redirect: 'manual' });
    expect(adminPage.status).toBeGreaterThanOrEqual(300);
    expect(adminPage.status).toBeLessThan(400);
  });

  it('A-09 user revoked mid-flow: next gated call is 403 even though the session is still valid (ticket-mint variant lands in M2)', async () => {
    const email = testEmail('revoked-admin');
    await seedParticipant(email, 'approved', ['admin']);
    const cookie = await createSessionCookie(email);

    expect((await api('/api/admin/participants', { cookie })).status).toBe(200);

    // another admin blocks them; no session state is touched
    const otherAdmin = testEmail('other-admin');
    await seedParticipant(otherAdmin, 'approved', ['admin']);
    const otherCookie = await createSessionCookie(otherAdmin);
    expect(
      (await api(`/api/admin/participants/${encodeURIComponent(email)}/status`, { cookie: otherCookie, body: { status: 'blocked' } }))
        .status,
    ).toBe(200);

    expect((await api('/api/admin/participants', { cookie })).status).toBe(403);
  });
});
