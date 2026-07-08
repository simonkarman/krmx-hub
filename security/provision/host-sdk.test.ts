import { describe, expect, it } from 'vitest';
import { PROVISION_TIMESTAMP_TOLERANCE_SECONDS } from '@hub/protocol';
import { signProvisionBody, verifyProvisionRequest } from '@hub/game-server-sdk';

const secret = 'webhook-secret-under-test';
const body = JSON.stringify({ instanceId: 'inst_1', serviceToken: 'svc', hubUrl: 'http://localhost:3000' });

describe('P — provision call verification (host SDK)', () => {
  it('happy path: a correctly signed, fresh call verifies', () => {
    const ts = Math.floor(Date.now() / 1000);
    const signature = signProvisionBody(secret, ts, body);
    expect(verifyProvisionRequest({ secret, timestamp: ts, signature, body })).toEqual({ ok: true });
  });

  it('P-01 unsigned call is rejected', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyProvisionRequest({ secret, timestamp: ts, signature: null, body }).ok).toBe(false);
    expect(verifyProvisionRequest({ secret, timestamp: ts, signature: '', body }).ok).toBe(false);
  });

  it('P-01 wrongly-signed call is rejected (wrong secret, tampered body, tampered sig)', () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = signProvisionBody(secret, ts, body);

    expect(verifyProvisionRequest({ secret, timestamp: ts, signature: signProvisionBody('other', ts, body), body }).ok).toBe(false);
    // signature valid for a different body
    expect(verifyProvisionRequest({ secret, timestamp: ts, signature: good, body: body + ' ' }).ok).toBe(false);
    // flip one hex char of the signature
    const flipped = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    const result = verifyProvisionRequest({ secret, timestamp: ts, signature: flipped, body });
    expect(result).toEqual({ ok: false, reason: 'signature' });
  });

  it('P-02 replayed call with a stale timestamp is rejected', () => {
    const now = Math.floor(Date.now() / 1000);
    const staleTs = now - (PROVISION_TIMESTAMP_TOLERANCE_SECONDS + 5);
    // signature is itself valid for that timestamp — only freshness fails
    const signature = signProvisionBody(secret, staleTs, body);
    expect(verifyProvisionRequest({ secret, timestamp: staleTs, signature, body, nowSeconds: now })).toEqual({
      ok: false,
      reason: 'stale',
    });
    // future timestamps beyond tolerance are equally rejected
    const futureTs = now + (PROVISION_TIMESTAMP_TOLERANCE_SECONDS + 5);
    expect(
      verifyProvisionRequest({ secret, timestamp: futureTs, signature: signProvisionBody(secret, futureTs, body), body, nowSeconds: now }).ok,
    ).toBe(false);
  });

  it('a non-numeric, blank, or missing timestamp is rejected as a timestamp problem (not read as 0)', () => {
    expect(verifyProvisionRequest({ secret, timestamp: 'not-a-number', signature: 'sha256=x', body })).toEqual({
      ok: false,
      reason: 'timestamp',
    });
    // regression: Number('') === 0 must not slip through as a (stale) timestamp
    expect(verifyProvisionRequest({ secret, timestamp: '', signature: 'sha256=x', body })).toEqual({
      ok: false,
      reason: 'timestamp',
    });
    expect(verifyProvisionRequest({ secret, timestamp: '   ', signature: 'sha256=x', body })).toEqual({
      ok: false,
      reason: 'timestamp',
    });
  });
});
