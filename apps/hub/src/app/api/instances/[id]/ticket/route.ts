import type { NextResponse } from 'next/server';
import { AuthzError, requireApproved } from '../../../../../lib/authz';
import { errorResponse, json } from '../../../../../lib/http';
import { getInstance, isInstancePlayer } from '../../../../../lib/instances';
import { allowRequest, TICKET_RATE_LIMIT_MAX, TICKET_RATE_LIMIT_WINDOW_MS } from '../../../../../lib/rate-limit';
import { currentParticipant } from '../../../../../lib/session';
import { mintTicket } from '../../../../../lib/tickets';

/**
 * Mints a player ticket (ARCHITECTURE §6.3 step 3). Re-checks live approved
 * status (§9.7, A-01/A-02/A-09), instance membership (A-03), and instance
 * liveness (A-04) on every call. The ticket travels only in this JSON body —
 * never in a URL (§9.3) — and is never logged (§9.13).
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const participant = requireApproved(await currentParticipant());

    if (!allowRequest(`ticket:${participant.email}`, TICKET_RATE_LIMIT_MAX, TICKET_RATE_LIMIT_WINDOW_MS)) {
      return json({ error: 'rate limited' }, 429); // A-10
    }

    const { id } = await ctx.params;
    const instance = await getInstance(id);
    if (!instance) return json({ error: 'instance not found' }, 404);
    if (!(await isInstancePlayer(id, participant.email))) {
      throw new AuthzError(403, 'not a player in this instance');
    }
    if (instance.status !== 'lobby' && instance.status !== 'running') {
      throw new AuthzError(403, 'instance is not active');
    }

    // Username management is out of M2 scope; email is unique and works as
    // the connect name until the example flow (M5) needs anything nicer.
    const username = participant.username ?? participant.email;
    const ticket = await mintTicket({ email: participant.email, username, instanceId: id });
    return json({ ticket, serverUrl: instance.serverUrl, instanceId: id, username });
  } catch (error) {
    return errorResponse(error);
  }
}
