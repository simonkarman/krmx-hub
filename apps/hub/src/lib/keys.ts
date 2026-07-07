import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, type JWK } from 'jose';

/**
 * Ticket signing keypair (ARCHITECTURE §4). The private key exists only in
 * the hub (§9.6): env `TICKET_PRIVATE_KEY` (PKCS8 PEM, \n-escapes allowed).
 * Dev fallback: an ephemeral per-process keypair — fine locally since
 * tickets live 2 minutes and JWKS serves whatever this process signs with.
 * Production refuses to start without the env var. `kid` is the RFC 7638
 * JWK thumbprint, so key rotation (§11) needs no naming scheme.
 */
interface TicketKeys {
  privateKey: KeyObject;
  publicJwk: JWK;
  kid: string;
}

declare global {
  var __ticketKeys: Promise<TicketKeys> | undefined;
}

async function loadTicketKeys(): Promise<TicketKeys> {
  let pem = process.env.TICKET_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!pem) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TICKET_PRIVATE_KEY is required in production');
    }
    console.warn('TICKET_PRIVATE_KEY not set — using an ephemeral dev keypair for this process');
    pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
  }
  const privateKey = createPrivateKey(pem);
  const jwk = await exportJWK(createPublicKey(privateKey));
  const kid = await calculateJwkThumbprint(jwk);
  return { privateKey, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, kid };
}

export function getTicketKeys(): Promise<TicketKeys> {
  return (globalThis.__ticketKeys ??= loadTicketKeys());
}
