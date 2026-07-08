// Applies db/migrations/*.sql in filename order, once each, tracked in a
// schema_migrations table. Each migration runs in its own transaction.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const connectionString = process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub';

// Managed Postgres (Neon) needs TLS; local docker Postgres does not.
const needsSsl = !/sslmode=disable/.test(connectionString) &&
  (/sslmode=require/.test(connectionString) || !/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString));

const client = new pg.Client({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: true } : undefined,
});
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rowCount > 0) {
      console.log(`skip    ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  console.log('migrations up to date');
} finally {
  await client.end();
}
