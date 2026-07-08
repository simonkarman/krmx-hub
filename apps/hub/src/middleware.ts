import { NextResponse } from 'next/server';

/**
 * Content-Security-Policy for the hub (ARCHITECTURE §7). `frame-src` is the
 * allowlist of registered game-frontend origins — the browser blocks the hub
 * from embedding anything else (F-05). `frame-ancestors 'none'` stops the hub
 * itself from being framed.
 *
 * The allowlist is configured per deploy via HUB_FRAME_ORIGINS (comma
 * separated). A DB-driven allowlist is a later refinement.
 */
function frameSrc(): string {
  const origins = (process.env.HUB_FRAME_ORIGINS ?? 'http://localhost:4000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ["'self'", ...origins].join(' ');
}

export function middleware(): NextResponse {
  const res = NextResponse.next();
  res.headers.set('Content-Security-Policy', `frame-src ${frameSrc()}; frame-ancestors 'none';`);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
