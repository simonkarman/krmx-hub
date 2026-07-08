import type { NextResponse } from 'next/server';
import { heartbeatRequestSchema } from '@hub/protocol';
import { pool } from '../../../../../../lib/db';
import { errorResponse, json } from '../../../../../../lib/http';
import { authenticateService } from '../../../../../../lib/service-auth';

/**
 * Service heartbeat (ARCHITECTURE §6.4). Auth is service-token only
 * (§9.5) — a session cookie grants nothing here. The optional state snapshot
 * is validated but not yet persisted (no column in §5); hub-side lobby display
 * reads it in a later milestone. Hub is never authoritative for game state.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await ctx.params;
    const auth = await authenticateService(req, id);
    if (!auth.ok) return json({ error: 'unauthorized' }, auth.status); // S-01, S-02, S-03, S-04

    const { status } = heartbeatRequestSchema.parse(await req.json());
    await pool.query(
      `UPDATE instance
         SET last_heartbeat_at = now(),
             status = CASE WHEN status IN ('provisioning', 'lobby', 'running') THEN $2 ELSE status END
       WHERE id = $1`,
      [id, status],
    );
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
