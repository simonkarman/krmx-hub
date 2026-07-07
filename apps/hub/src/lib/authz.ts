import type { Participant } from './participants';

/**
 * Pure authorization gates. Every API route, page, and server action calls
 * these on a freshly loaded participant row (ARCHITECTURE §9.9) — session
 * claims are never trusted for authorization, so status/role changes take
 * effect on the very next request (A-02, A-09).
 */
export class AuthzError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'AuthzError';
  }
}

export function requireParticipant(participant: Participant | null): Participant {
  if (!participant) throw new AuthzError(401, 'authentication required');
  return participant;
}

/** The approval gate: instance create/join and ticket minting (M2/M3) go through this. */
export function requireApproved(participant: Participant | null): Participant {
  const p = requireParticipant(participant);
  if (p.status !== 'approved') throw new AuthzError(403, 'account not approved');
  return p;
}

export function requireAdmin(participant: Participant | null): Participant {
  const p = requireApproved(participant);
  if (!p.roles.includes('admin')) throw new AuthzError(403, 'admin role required');
  return p;
}
