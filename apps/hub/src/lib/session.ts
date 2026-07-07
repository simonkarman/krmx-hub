import { auth } from '../auth';
import { getParticipant, type Participant } from './participants';

/**
 * Resolves the caller's participant row live from the database on every call
 * (ARCHITECTURE §9.9). The status/roles copied onto the session object are
 * for UI display only and must never be used for authorization.
 */
export async function currentParticipant(): Promise<Participant | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;
  return getParticipant(email);
}
