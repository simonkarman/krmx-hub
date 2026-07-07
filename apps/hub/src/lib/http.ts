import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AuthzError } from './authz';

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/**
 * Maps errors to responses. Logs message + stack only, never full error
 * objects: pg error fields like `detail` can echo inserted values, and tokens
 * must never reach logs (ARCHITECTURE §9.13).
 */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof AuthzError) return json({ error: error.message }, error.status);
  if (error instanceof ZodError) return json({ error: 'invalid request body' }, 400);
  if (error instanceof SyntaxError) return json({ error: 'invalid JSON' }, 400);
  console.error('unhandled API error:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  return json({ error: 'internal error' }, 500);
}
