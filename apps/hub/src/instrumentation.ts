/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * Boots the reaper loop (§6.4). In production (M7) this becomes a scheduled
 * function instead; the security-test hub sets HUB_DISABLE_REAPER so it never
 * races the test fixtures.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.HUB_DISABLE_REAPER === '1') return;
  const { startReaper } = await import('./lib/reaper');
  startReaper();
}
