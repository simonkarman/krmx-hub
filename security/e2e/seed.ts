import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeedData {
  gameId: string;
  webhookSecret: string;
  instanceA: string;
  instanceB: string;
  serviceTokenB: string;
  gamePort: number;
  hubLog: string;
  gameLog: string;
  users: {
    p1: { email: string; token: string };
    p2: { email: string; token: string };
    nonMember: { email: string; token: string };
  };
}

const dir = path.dirname(fileURLToPath(import.meta.url));
export const seed: SeedData = JSON.parse(readFileSync(path.join(dir, '.seed.json'), 'utf8'));

/**
 * An Auth.js database-session cookie for localhost, ready for
 * context.addCookies. httpOnly matches how the hub actually sets it (M1 dev
 * login + Auth.js), so it is not readable via document.cookie — important for
 * F-03, since on the localhost harness cookies are host- not port-scoped and
 * would otherwise reach the :4000 frame.
 */
export function sessionCookie(token: string) {
  return {
    name: 'authjs.session-token',
    value: token,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  } as const;
}

/** Matches an RS256 JWT (the player ticket shape) anywhere in a string. */
export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
