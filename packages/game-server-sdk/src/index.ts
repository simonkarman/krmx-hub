import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { PROVISION_TIMESTAMP_TOLERANCE_SECONDS, ticketClaimsSchema, type TicketClaims } from '@hub/protocol';

/**
 * @hub/game-server-sdk — ticket verification for game servers.
 *
 * Verification is fully offline after the first (cached) JWKS fetch
 * (ARCHITECTURE §4). HubServiceClient (heartbeat/results) arrives with M3.
 */

export class TicketVerificationError extends Error {
  override name = 'TicketVerificationError';
}

/** Thrown when a jti is presented twice (§9.11; T-08). */
export class TicketReplayError extends TicketVerificationError {
  override name = 'TicketReplayError';
}

export interface TicketVerifierOptions {
  /** Hub base URL; the JWKS is fetched (and cached by jose) from <hubUrl>/.well-known/jwks.json. */
  hubUrl: string;
  /** Optional expected `iss` claim. */
  issuer?: string;
  /** Allowed clock skew in seconds (default 5). */
  clockToleranceSeconds?: number;
}

export interface TicketVerifier {
  /**
   * Verifies a player ticket and returns its claims. `expectedAud` is passed
   * per call (not per verifier) to keep room-scoped audiences possible later
   * (ARCHITECTURE §11). Callers must compare `claims.name` against the
   * username the player is connecting with (T-06) — the krmx-adapter does
   * this in M5.
   */
  verifyTicket(ticket: string, expectedAud: string): Promise<TicketClaims>;
}

export function createTicketVerifier(options: TicketVerifierOptions): TicketVerifier {
  const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', options.hubUrl));
  const clockTolerance = options.clockToleranceSeconds ?? 5;
  // Single-use jti set (§9.11). Entries expire with their ticket, so the map
  // stays bounded by the number of tickets minted per ticket lifetime.
  const seenJtis = new Map<string, number>();

  return {
    async verifyTicket(ticket, expectedAud) {
      const { payload } = await jwtVerify(ticket, jwks, {
        algorithms: ['RS256'], // explicit allowlist (§9.12) — never derived from the token header (T-01, T-02)
        audience: expectedAud, // aud scoping (T-05)
        clockTolerance,
        ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
      });

      const parsed = ticketClaimsSchema.safeParse(payload);
      if (!parsed.success) throw new TicketVerificationError('ticket claims malformed');
      const claims = parsed.data;

      const now = Date.now();
      for (const [jti, expiresAt] of seenJtis) {
        if (expiresAt <= now) seenJtis.delete(jti);
      }
      if (seenJtis.has(claims.jti)) throw new TicketReplayError('ticket already used');
      seenJtis.set(claims.jti, (claims.exp + clockTolerance) * 1000);

      return claims;
    },
  };
}

// ── Provision-call HMAC (ARCHITECTURE §6.1 step 3, §9.14) ──────────────────
// Shared by the hub (signer) and host provision endpoints (verifier) so the
// exact byte layout can never drift. Signature covers `${timestamp}.${body}`.

/** Produces the `x-hub-signature` header value: `sha256=<hex hmac>`. */
export function signProvisionBody(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `sha256=${mac}`;
}

export interface VerifyProvisionInput {
  secret: string;
  /** The `x-hub-timestamp` header (unix seconds). */
  timestamp: string | number;
  /** The `x-hub-signature` header. */
  signature: string | null | undefined;
  /** The exact raw request body the signature was computed over. */
  body: string;
  toleranceSeconds?: number;
  /** Current unix seconds; injectable for tests. */
  nowSeconds?: number;
}

export type VerifyProvisionResult = { ok: true } | { ok: false; reason: 'timestamp' | 'stale' | 'signature' };

/**
 * Verifies a provision call's signature and freshness. Rejects a missing or
 * malformed timestamp, a timestamp outside the ±window (replay; P-02), and any
 * signature mismatch (P-01). Constant-time signature comparison.
 */
export function verifyProvisionRequest(input: VerifyProvisionInput): VerifyProvisionResult {
  // A missing/blank header must not read as timestamp 0 (Number('') === 0).
  const raw = typeof input.timestamp === 'string' ? input.timestamp.trim() : input.timestamp;
  if (raw === '' || raw === null || raw === undefined) return { ok: false, reason: 'timestamp' };
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp' };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? PROVISION_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: 'stale' };

  const expected = Buffer.from(signProvisionBody(input.secret, ts, input.body));
  const provided = Buffer.from(input.signature ?? '');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'signature' };
  }
  return { ok: true };
}
