import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../helpers/db';
import { api, cleanupTestData, createSessionCookie, seedParticipant, testEmail } from '../helpers/hub';

afterAll(async () => {
  await cleanupTestData();
  await pool.end();
});

async function adminCookie(): Promise<string> {
  const email = testEmail('admin');
  await seedParticipant(email, 'approved', ['admin']);
  return createSessionCookie(email);
}

describe('admin dashboard functionality (M1)', () => {
  it('approve/block and role grant/revoke round-trip through the API', async () => {
    const cookie = await adminCookie();
    const target = testEmail('flow-target');
    await seedParticipant(target, 'pending');
    const base = `/api/admin/participants/${encodeURIComponent(target)}`;

    const approve = await api(`${base}/status`, { cookie, body: { status: 'approved' } });
    expect(approve.status).toBe(200);
    const approved = (await approve.json()).participant;
    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toContain('admin-');

    const grantHost = await api(`${base}/roles`, { cookie, body: { role: 'host', op: 'grant' } });
    expect((await grantHost.json()).participant.roles).toEqual(['host']);
    // grants are idempotent
    const again = await api(`${base}/roles`, { cookie, body: { role: 'host', op: 'grant' } });
    expect((await again.json()).participant.roles).toEqual(['host']);
    const revoke = await api(`${base}/roles`, { cookie, body: { role: 'host', op: 'revoke' } });
    expect((await revoke.json()).participant.roles).toEqual([]);

    const block = await api(`${base}/status`, { cookie, body: { status: 'blocked' } });
    expect((await block.json()).participant.status).toBe('blocked');

    expect((await api(`/api/admin/participants/missing%40sec-test.local/status`, { cookie, body: { status: 'approved' } })).status).toBe(404);
  });

  it('credit grants write exactly one positive grant ledger row and report the balance', async () => {
    const cookie = await adminCookie();
    const target = testEmail('credit-target');
    await seedParticipant(target, 'approved');
    const base = `/api/admin/participants/${encodeURIComponent(target)}`;

    const first = await api(`${base}/credits`, { cookie, body: { amount: 25 } });
    expect(first.status).toBe(200);
    expect((await first.json()).balance).toBe(25);
    const second = await api(`${base}/credits`, { cookie, body: { amount: 15 } });
    expect((await second.json()).balance).toBe(40);

    const { rows } = await pool.query('SELECT type, amount, instance_id FROM ledger WHERE email = $1 ORDER BY id', [target]);
    expect(rows).toEqual([
      { type: 'grant', amount: 25, instance_id: null },
      { type: 'grant', amount: 15, instance_id: null },
    ]);
  });

  it('credit grants reject zero, negative, and non-integer amounts with 400 and write nothing', async () => {
    const cookie = await adminCookie();
    const target = testEmail('bad-credit-target');
    await seedParticipant(target, 'approved');
    const base = `/api/admin/participants/${encodeURIComponent(target)}`;

    for (const amount of [0, -5, 2.5, '10']) {
      const res = await api(`${base}/credits`, { cookie, body: { amount } });
      expect(res.status).toBe(400);
    }
    const { rows } = await pool.query('SELECT * FROM ledger WHERE email = $1', [target]);
    expect(rows).toEqual([]);
  });

  it('status and roles endpoints reject unknown values (zod)', async () => {
    const cookie = await adminCookie();
    const target = testEmail('zod-target');
    await seedParticipant(target, 'pending');
    const base = `/api/admin/participants/${encodeURIComponent(target)}`;

    expect((await api(`${base}/status`, { cookie, body: { status: 'pending' } })).status).toBe(400);
    expect((await api(`${base}/status`, { cookie, body: { status: 'owner' } })).status).toBe(400);
    expect((await api(`${base}/roles`, { cookie, body: { role: 'superadmin', op: 'grant' } })).status).toBe(400);
  });

  it('dev login route does not exist in production builds (NODE_ENV guard)', async () => {
    // global-setup runs the hub with `next start` (production)
    const res = await api('/api/dev/login', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
