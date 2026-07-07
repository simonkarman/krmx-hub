import NextAuth from 'next-auth';
import PostgresAdapter from '@auth/pg-adapter';
import { pool } from './lib/db';
import { getParticipant } from './lib/participants';

/**
 * Auth.js v5 with database sessions (ARCHITECTURE §4: DB session cookie).
 *
 * Phase 0 has no providers: the dev login route
 * (app/api/dev/login, NODE_ENV-guarded) creates Auth.js session rows
 * directly, so the session machinery is already exactly what real OAuth
 * (M6) will use. The built-in Credentials provider was deliberately NOT
 * used — it only supports JWT sessions, which would contradict §4.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PostgresAdapter(pool),
  session: { strategy: 'database' },
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : 'krmx-hub-dev-secret'),
  providers: [],
  callbacks: {
    async session({ session, user }) {
      // Display-only convenience; authorization always re-reads the DB (§9.9).
      const participant = user.email ? await getParticipant(user.email) : null;
      session.user.status = participant?.status ?? 'pending';
      session.user.roles = participant?.roles ?? [];
      return session;
    },
  },
});
