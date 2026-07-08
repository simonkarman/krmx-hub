import NextAuth, { type NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import PostgresAdapter from '@auth/pg-adapter';
import { pool } from './lib/db';
import { ensureParticipant, getParticipant } from './lib/participants';

/**
 * Auth.js v5 with database sessions (ARCHITECTURE §4: DB session cookie).
 *
 * Phase 1 (M6) adds real providers, each enabled only when its secrets are
 * present so local dev and the test harness keep working with no providers:
 *  - Google OAuth (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET),
 *  - Resend magic links (AUTH_RESEND_KEY + AUTH_EMAIL_FROM).
 * The dev-only credentials login (app/api/dev/login, NODE_ENV-guarded) stays.
 */
function providers(): NextAuthConfig['providers'] {
  const list: NextAuthConfig['providers'] = [];
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    list.push(Google); // reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET
  }
  if (process.env.AUTH_RESEND_KEY) {
    list.push(Resend({ from: process.env.AUTH_EMAIL_FROM ?? 'onboarding@resend.dev' }));
  }
  return list;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PostgresAdapter(pool),
  session: { strategy: 'database' },
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : 'krmx-hub-dev-secret'),
  providers: providers(),
  events: {
    // OAuth / magic-link sign-ins go through Auth.js (unlike the dev route,
    // which calls ensureParticipant itself), so land every new identity in the
    // participant table — pending, unless it's the ADMIN_EMAIL bootstrap (§2).
    async signIn({ user }) {
      if (user.email) await ensureParticipant(user.email);
    },
  },
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
