import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '../../../../lib/db';
import { ensureParticipant } from '../../../../lib/participants';
import { errorResponse } from '../../../../lib/http';

const bodySchema = z.object({ email: z.string().email().max(254) });

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Phase 0 dev credentials login (ARCHITECTURE §10: localhost-only). Trades a
 * form email for a real Auth.js database session so everything downstream
 * behaves exactly as it will with OAuth in M6. Hard NODE_ENV guard: this
 * route does not exist in production builds.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse(null, { status: 404 });
  }
  try {
    const form = await req.formData();
    const { email } = bodySchema.parse({ email: form.get('email') });

    await ensureParticipant(email);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO users (name, email) VALUES ($1, $1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email],
    );
    const userId = rows[0];
    if (!userId) throw new Error('user upsert failed');

    const sessionToken = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query('INSERT INTO sessions ("userId", "sessionToken", expires) VALUES ($1, $2, $3)', [
      userId.id,
      sessionToken,
      expires,
    ]);

    const res = NextResponse.redirect(new URL('/', req.url), 303);
    res.cookies.set('authjs.session-token', sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires,
    });
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
