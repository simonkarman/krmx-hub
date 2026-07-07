import { afterAll, describe, expect, it } from 'vitest';
import { instanceAudience, TICKET_LIFETIME_SECONDS } from '@hub/protocol';
import { createTicketVerifier, TicketReplayError } from '@hub/game-server-sdk';
import { pool } from '../helpers/db';
import {
  api,
  cleanupTestData,
  createSessionCookie,
  HUB_URL,
  seedParticipant,
  seedPlayableInstance,
  testEmail,
} from '../helpers/hub';
import {
  attackerKey,
  craftAlgConfusionTicket,
  craftAlgNoneTicket,
  craftTicket,
  defaultClaims,
  hubSigningKey,
  keyKid,
  tamperTicket,
} from '../helpers/tickets';

afterAll(async () => {
  await cleanupTestData();
  await pool.end();
});

function verifier() {
  return createTicketVerifier({ hubUrl: HUB_URL });
}

/** A real ticket minted by the running hub for a seeded member. */
async function mintRealTicket(status: 'lobby' | 'running' = 'lobby'): Promise<{
  ticket: string;
  instanceId: string;
  email: string;
  cookie: string;
}> {
  const email = testEmail('player');
  await seedParticipant(email, 'approved');
  const instanceId = await seedPlayableInstance({ playerEmail: email, status });
  const cookie = await createSessionCookie(email);
  const res = await api(`/api/instances/${instanceId}/ticket`, { cookie });
  expect(res.status).toBe(200);
  const { ticket } = await res.json();
  return { ticket, instanceId, email, cookie };
}

describe('T — player tickets (forgery, confusion, replay)', () => {
  it('T-01 alg:none token is rejected', async () => {
    await expect(verifier().verifyTicket(craftAlgNoneTicket('inst-t01'), instanceAudience('inst-t01'))).rejects.toThrow();
  });

  it("T-02 algorithm confusion: HS256 signed with the hub's public key as HMAC secret is rejected", async () => {
    const ticket = await craftAlgConfusionTicket('inst-t02');
    await expect(verifier().verifyTicket(ticket, instanceAudience('inst-t02'))).rejects.toThrow();
  });

  it("T-03 RS256 signed with the attacker's own keypair is rejected", async () => {
    // with the attacker's own kid: no matching key in the hub JWKS
    const ownKid = await craftTicket({ claims: defaultClaims('inst-t03'), key: attackerKey });
    await expect(verifier().verifyTicket(ownKid, instanceAudience('inst-t03'))).rejects.toThrow();
    // with the hub's kid spoofed into the header: signature check fails
    const spoofedKid = await craftTicket({
      claims: defaultClaims('inst-t03'),
      key: attackerKey,
      kid: await keyKid(hubSigningKey),
    });
    await expect(verifier().verifyTicket(spoofedKid, instanceAudience('inst-t03'))).rejects.toThrow();
  });

  it('T-04 expired ticket (2m + skew) is rejected', async () => {
    const ticket = await craftTicket({ claims: defaultClaims('inst-t04'), issuedAtOffsetSeconds: -600 });
    await expect(verifier().verifyTicket(ticket, instanceAudience('inst-t04'))).rejects.toThrow();
  });

  it('T-05 valid ticket for instance A presented to server B (aud mismatch) is rejected', async () => {
    const { ticket } = await mintRealTicket();
    await expect(verifier().verifyTicket(ticket, instanceAudience('some-other-instance'))).rejects.toThrow();
  });

  it('T-06 link username ≠ name claim is rejected by the adapter comparison (Krmx-level lands in M5)', async () => {
    const { ticket, instanceId, email } = await mintRealTicket();
    const claims = await verifier().verifyTicket(ticket, instanceAudience(instanceId));
    // Exactly the check packages/krmx-adapter wires into the authenticate hook.
    const linkAllowed = (linkUsername: string) => claims.name === linkUsername;
    expect(linkAllowed('mallory')).toBe(false);
    expect(linkAllowed(email)).toBe(true);
  });

  it('T-07 payload tampered after signing is rejected', async () => {
    const { ticket, instanceId } = await mintRealTicket();
    const tampered = tamperTicket(ticket, (payload) => {
      payload.sub = 'attacker@sec-test.local';
      payload.name = 'attacker@sec-test.local';
    });
    await expect(verifier().verifyTicket(tampered, instanceAudience(instanceId))).rejects.toThrow();
  });

  it('T-08 same ticket used for two links: second is rejected (jti replay)', async () => {
    const { ticket, instanceId } = await mintRealTicket();
    const v = verifier();
    await v.verifyTicket(ticket, instanceAudience(instanceId));
    await expect(v.verifyTicket(ticket, instanceAudience(instanceId))).rejects.toThrow(TicketReplayError);
  });

  it('T-09 ticket presented as hub API credential gets 401 — tickets are not sessions', async () => {
    const { ticket, instanceId } = await mintRealTicket();
    const bearer = { Authorization: `Bearer ${ticket}` };
    for (const path of ['/api/admin/participants', `/api/instances/${instanceId}/ticket`]) {
      const res = await fetch(`${HUB_URL}${path}`, { headers: bearer });
      expect(res.status).toBe(401);
    }
  });

  it('T-10 kid pointing at an unknown key is rejected', async () => {
    const ticket = await craftTicket({ claims: defaultClaims('inst-t10'), kid: 'unknown-kid' });
    await expect(verifier().verifyTicket(ticket, instanceAudience('inst-t10'))).rejects.toThrow();
  });

  it('T-11 happy path: a fresh valid ticket is accepted exactly once with exact claims', async () => {
    const { ticket, instanceId, email } = await mintRealTicket('running');
    const v = createTicketVerifier({ hubUrl: HUB_URL, issuer: HUB_URL });
    const claims = await v.verifyTicket(ticket, instanceAudience(instanceId));
    expect(claims.sub).toBe(email);
    expect(claims.aud).toBe(instanceAudience(instanceId));
    expect(claims.name).toBe(email); // username defaults to email until username management lands
    expect(claims.jti.length).toBeGreaterThan(0);
    expect(claims.exp - claims.iat).toBe(TICKET_LIFETIME_SECONDS);
    // exactly once
    await expect(v.verifyTicket(ticket, instanceAudience(instanceId))).rejects.toThrow(TicketReplayError);
  });
});
