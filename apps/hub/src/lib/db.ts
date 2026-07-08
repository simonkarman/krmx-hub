import pg from 'pg';

declare global {
  // Cached across hot reloads in dev so `next dev` doesn't leak pools.
  var __hubPool: pg.Pool | undefined;
}

const connectionString = process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub';

/**
 * Managed Postgres (Neon, M6) requires TLS; local docker Postgres does not.
 * Enable SSL when the connection string asks for it or the host isn't local.
 * Neon presents a valid certificate, so keep verification on.
 */
export function needsSsl(url: string): boolean {
  if (/sslmode=disable/.test(url)) return false;
  return /sslmode=require/.test(url) || !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
}

export const pool: pg.Pool =
  globalThis.__hubPool ??
  new pg.Pool({
    connectionString,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: true } : undefined,
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__hubPool = pool;
}
