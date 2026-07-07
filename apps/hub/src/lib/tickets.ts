import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { instanceAudience, TICKET_LIFETIME_SECONDS } from '@hub/protocol';
import { getTicketKeys } from './keys';

export function hubIssuer(): string {
  return process.env.HUB_URL ?? 'http://localhost:3000';
}

/** Mints a 2-minute single-use RS256 player ticket (ARCHITECTURE §4). */
export async function mintTicket(opts: {
  email: string;
  username: string;
  instanceId: string;
}): Promise<string> {
  const { privateKey, kid } = await getTicketKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ name: opts.username })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(hubIssuer())
    .setSubject(opts.email)
    .setAudience(instanceAudience(opts.instanceId))
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + TICKET_LIFETIME_SECONDS)
    .sign(privateKey);
}
