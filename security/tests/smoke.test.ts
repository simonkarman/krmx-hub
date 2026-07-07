import { describe, expect, it } from 'vitest';
import pg from 'pg';

// Requires `pnpm db:up && pnpm db:migrate` (see docker-compose.yml).
const connectionString = process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub';

describe('M0 smoke', () => {
  it('connects to Postgres and finds the migrated schema', async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const { rows } = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const tables = rows.map((row) => row.table_name);
      for (const expected of ['participant', 'game', 'game_version', 'instance', 'instance_player', 'ledger']) {
        expect(tables).toContain(expected);
      }
    } finally {
      await client.end();
    }
  });
});
