import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no ambiguous chars

function base32(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Non-secret instance id (schema calls for a nanoid; §5). */
export function newInstanceId(): string {
  return `inst_${base32(randomBytes(12))}`;
}

/** Non-secret, shareable invite code. */
export function newInviteCode(): string {
  return base32(randomBytes(8));
}
