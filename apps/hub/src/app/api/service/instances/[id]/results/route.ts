import type { NextResponse } from 'next/server';
import { resultsRequestSchema } from '@hub/protocol';
import { errorResponse, json } from '../../../../../../lib/http';
import { LedgerError, settleInstance } from '../../../../../../lib/ledger';
import { authenticateService } from '../../../../../../lib/service-auth';

/**
 * Results / settlement (ARCHITECTURE §6.4). Service-token auth scoped to this
 * instance (§9.5). Settlement validates the ranking against the seated players
 * (S-06), captures holds into payouts, marks the instance finished, and — via
 * that terminal status — revokes the token, so a replayed call is rejected at
 * the auth layer (a direct double-settle is also idempotent; L-01). All money
 * writes happen in one transaction (L-03/L-04 guards reject atomically).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await ctx.params;
    const auth = await authenticateService(req, id);
    if (!auth.ok) return json({ error: 'unauthorized' }, auth.status);

    const { ranking } = resultsRequestSchema.parse(await req.json());

    try {
      const result = await settleInstance(id, ranking);
      if (result.alreadySettled) return json({ ok: true, alreadySettled: true });
      return json({ ok: true, payouts: result.payouts });
    } catch (error) {
      if (error instanceof LedgerError) {
        // invalid ranking (incl. non-player, S-06) → 400; wrong state → 409.
        const status = error.code === 'not_settleable' ? 409 : 400;
        return json({ error: error.code }, status);
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
