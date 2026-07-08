import type { Server } from '@krmx/server';
import { instanceAudience } from '@hub/protocol';
import { createTicketVerifier } from '@hub/game-server-sdk';

export interface HubAuthenticationOptions {
  /** Hub base URL; JWKS is fetched from <hubUrl>/.well-known/jwks.json. */
  hubUrl: string;
  /** This server's instance id; tickets must carry aud = instance:<id> (T-05). */
  instanceId: string;
  /** Optional expected issuer. */
  issuer?: string;
}

/**
 * Wires hub ticket verification into Krmx's authenticate hook
 * (ARCHITECTURE §8, §6.3 step 4). The client links with `link(username,
 * ticket)`; we verify the ticket offline via JWKS, pin its audience to this
 * instance, enforce single use (jti), and require the ticket's `name` to match
 * the requested username (T-06). Every ticket failure rejects the link.
 */
export function useHubAuthentication(server: Server, options: HubAuthenticationOptions): void {
  const verifier = createTicketVerifier({ hubUrl: options.hubUrl, issuer: options.issuer });
  const expectedAud = instanceAudience(options.instanceId);

  server.on('authenticate', (username, info, reject, markAsync) => {
    markAsync(async () => {
      if (!info.auth) return reject('missing ticket');
      try {
        const claims = await verifier.verifyTicket(info.auth, expectedAud);
        if (claims.name !== username) reject('ticket does not match username');
      } catch {
        reject('invalid ticket');
      }
    });
  });
}
