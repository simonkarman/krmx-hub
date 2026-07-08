import type { NextResponse } from 'next/server';
import { requireApproved } from '../../../../../lib/authz';
import { errorResponse, json } from '../../../../../lib/http';
import { joinInstance, LedgerError } from '../../../../../lib/ledger';
import { currentParticipant } from '../../../../../lib/session';

const LEDGER_STATUS: Record<string, number> = {
  not_found: 404,
  not_approved: 403,
  not_joinable: 409,
  capacity_full: 409,
  insufficient_balance: 402,
};

/**
 * Join an instance (ARCHITECTURE §6.2). Authorization is re-checked live here
 * and again inside the ledger transaction (§9.9). The transaction enforces
 * capacity, balance, and single-membership atomically.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const participant = requireApproved(await currentParticipant());
    const { id } = await ctx.params;
    const result = await joinInstance(id, participant.email);
    return json({ joined: true, alreadyMember: result.alreadyMember });
  } catch (error) {
    if (error instanceof LedgerError) {
      return json({ error: error.code }, LEDGER_STATUS[error.code] ?? 400);
    }
    return errorResponse(error);
  }
}
