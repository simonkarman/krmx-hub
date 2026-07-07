import pg from 'pg';

declare global {
  // Cached across hot reloads in dev so `next dev` doesn't leak pools.
  var __hubPool: pg.Pool | undefined;
}

export const pool: pg.Pool =
  globalThis.__hubPool ??
  new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub',
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__hubPool = pool;
}
