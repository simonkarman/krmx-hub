import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateJwkThumbprint, exportJWK, SignJWT } from 'jose';
import { instanceAudience, TICKET_LIFETIME_SECONDS } from '@hub/protocol';
import { HUB_URL } from './hub';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** The key the test hub signs with (global-setup injects it as TICKET_PRIVATE_KEY). */
export const hubSigningKey: KeyObject = createPrivateKey(readFileSync(path.join(fixturesDir, 'ticket-signing-key.pem'), 'utf8'));
/** Never given to the hub (T-03). */
export const attackerKey: KeyObject = createPrivateKey(readFileSync(path.join(fixturesDir, 'attacker-key.pem'), 'utf8'));

export async function keyKid(key: KeyObject): Promise<string> {
  return calculateJwkThumbprint(await exportJWK(createPublicKey(key)));
}

export function defaultClaims(instanceId: string): Record<string, unknown> {
  return {
    sub: 'victim@sec-test.local',
    name: 'victim@sec-test.local',
    aud: instanceAudience(instanceId),
    jti: randomUUID(),
  };
}

/** Signs an RS256 token with full control over claims, key, kid and timestamps. */
export async function craftTicket(opts: {
  claims: Record<string, unknown>;
  key?: KeyObject;
  kid?: string;
  issuedAtOffsetSeconds?: number;
  lifetimeSeconds?: number;
}): Promise<string> {
  const key = opts.key ?? hubSigningKey;
  const kid = opts.kid ?? (await keyKid(key));
  const now = Math.floor(Date.now() / 1000) + (opts.issuedAtOffsetSeconds ?? 0);
  const { aud, sub, jti, ...rest } = opts.claims;
  let jwt = new SignJWT(rest)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(HUB_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.lifetimeSeconds ?? TICKET_LIFETIME_SECONDS));
  if (typeof aud === 'string') jwt = jwt.setAudience(aud);
  if (typeof sub === 'string') jwt = jwt.setSubject(sub);
  if (typeof jti === 'string') jwt = jwt.setJti(jti);
  return jwt.sign(key);
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned `alg: none` token (T-01). */
export function craftAlgNoneTicket(instanceId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...defaultClaims(instanceId), iss: HUB_URL, iat: now, exp: now + TICKET_LIFETIME_SECONDS };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
}

/** An HS256 token using the hub's PUBLIC key as the HMAC secret (T-02). */
export async function craftAlgConfusionTicket(instanceId: string): Promise<string> {
  const publicPem = createPublicKey(hubSigningKey).export({ type: 'spki', format: 'pem' }).toString();
  const now = Math.floor(Date.now() / 1000);
  const claims = defaultClaims(instanceId);
  return new SignJWT({ name: claims.name as string })
    .setProtectedHeader({ alg: 'HS256', kid: await keyKid(hubSigningKey) })
    .setIssuer(HUB_URL)
    .setSubject(claims.sub as string)
    .setAudience(claims.aud as string)
    .setJti(claims.jti as string)
    .setIssuedAt(now)
    .setExpirationTime(now + TICKET_LIFETIME_SECONDS)
    .sign(new TextEncoder().encode(publicPem));
}

/** Re-encodes the payload with a change, keeping the original signature (T-07). */
export function tamperTicket(ticket: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [header, payload, signature] = ticket.split('.');
  if (!header || !payload || !signature) throw new Error('not a JWT');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  mutate(decoded);
  return `${header}.${b64url(decoded)}.${signature}`;
}
