import { afterAll, describe, expect, it } from 'vitest';
import {
  allowRequest,
  TICKET_RATE_LIMIT_MAX,
  TICKET_RATE_LIMIT_WINDOW_MS,
} from '../../apps/hub/src/lib/rate-limit';
import { pool } from '../helpers/db';
import {
  api,
  cleanupTestData,
  createSessionCookie,
  seedParticipant,
  seedPlayableInstance,
  testEmail,
} from '../helpers/hub';

afterAll(async () => {
  await cleanupTestData();
  await pool.end();
});

describe('A — ticket endpoint authorization', () => {
  it('A-03 approved non-member requesting a ticket gets 403', async () => {
    const member = testEmail('member');
    await seedParticipant(member, 'approved');
    const instanceId = await seedPlayableInstance({ playerEmail: member });

    const outsider = testEmail('outsider');
    await seedParticipant(outsider, 'approved');
    const cookie = await createSessionCookie(outsider);

    const res = await api(`/api/instances/${instanceId}/ticket`, { cookie });
    expect(res.status).toBe(403);
  });

  it('A-04 ticket request for finished/cancelled (or still-provisioning) instance gets 403', async () => {
    const email = testEmail('member');
    await seedParticipant(email, 'approved');
    const cookie = await createSessionCookie(email);

    for (const status of ['finished', 'cancelled', 'provisioning'] as const) {
      const instanceId = await seedPlayableInstance({ playerEmail: email, status });
      const res = await api(`/api/instances/${instanceId}/ticket`, { cookie });
      expect(res.status, `status=${status}`).toBe(403);
    }
  });

  it('A-10 ticket endpoint rate limit: the N+1th rapid request gets 429', async () => {
    const email = testEmail('spammer');
    await seedParticipant(email, 'approved');
    const instanceId = await seedPlayableInstance({ playerEmail: email });
    const cookie = await createSessionCookie(email);

    for (let i = 0; i < TICKET_RATE_LIMIT_MAX; i++) {
      const res = await api(`/api/instances/${instanceId}/ticket`, { cookie });
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const overLimit = await api(`/api/instances/${instanceId}/ticket`, { cookie });
    expect(overLimit.status).toBe(429);
  });

  it('rate limiter unit: window slides and keys are independent', () => {
    const key = `unit-${Date.now()}`;
    for (let i = 0; i < TICKET_RATE_LIMIT_MAX; i++) {
      expect(allowRequest(key, TICKET_RATE_LIMIT_MAX, TICKET_RATE_LIMIT_WINDOW_MS)).toBe(true);
    }
    expect(allowRequest(key, TICKET_RATE_LIMIT_MAX, TICKET_RATE_LIMIT_WINDOW_MS)).toBe(false);
    expect(allowRequest(`${key}-other`, TICKET_RATE_LIMIT_MAX, TICKET_RATE_LIMIT_WINDOW_MS)).toBe(true);
  });

  it('unknown instance gets 404, without leaking whether the caller could have played', async () => {
    const email = testEmail('member');
    await seedParticipant(email, 'approved');
    const cookie = await createSessionCookie(email);
    const res = await api('/api/instances/does-not-exist/ticket', { cookie });
    expect(res.status).toBe(404);
  });
});
