import { pool } from './db';
import { cancelInstance } from './ledger';

export const REAPER_HEARTBEAT_INTERVAL_MS = 60_000;
/** Stale after 3 missed heartbeats (ARCHITECTURE §6.4). */
export const REAPER_STALE_AFTER_MS = 3 * REAPER_HEARTBEAT_INTERVAL_MS;

declare global {
  var __reaperTimer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Cancels instances whose server has gone silent (§6.4). An active instance is
 * stale when its last heartbeat (or, if it never sent one, its creation time)
 * is older than the window. Each stale instance is cancelled through
 * cancelInstance, which releases its entry holds and (via the terminal status)
 * revokes its service token — completing L-09.
 */
export async function reapStaleInstances(now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - REAPER_STALE_AFTER_MS);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM instance
      WHERE status IN ('provisioning', 'lobby', 'running')
        AND COALESCE(last_heartbeat_at, created_at) < $1`,
    [cutoff],
  );
  const reaped: string[] = [];
  for (const { id } of rows) {
    // cancelInstance locks the row and no-ops if it raced another transition.
    if (await cancelInstance(id)) reaped.push(id);
  }
  return reaped;
}

/** Starts the dev-mode reaper loop (single timer per process). */
export function startReaper(): void {
  if (globalThis.__reaperTimer) return;
  globalThis.__reaperTimer = setInterval(() => {
    reapStaleInstances()
      .then((ids) => {
        if (ids.length > 0) console.log(`reaper cancelled ${ids.length} stale instance(s)`);
      })
      .catch((err) => console.error('reaper error:', err instanceof Error ? err.message : String(err)));
  }, REAPER_HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive solely for the reaper.
  globalThis.__reaperTimer.unref?.();
}
