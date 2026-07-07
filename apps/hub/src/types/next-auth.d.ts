import type { DefaultSession } from 'next-auth';
import type { ParticipantStatus } from '../lib/participants';

declare module 'next-auth' {
  interface Session {
    user: {
      /** Display only — authorization re-reads the participant row (§9.9). */
      status: ParticipantStatus;
      roles: string[];
    } & DefaultSession['user'];
  }
}
