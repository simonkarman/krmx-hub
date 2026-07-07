import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '../../../../../../lib/authz';
import { errorResponse, json } from '../../../../../../lib/http';
import { setParticipantStatus } from '../../../../../../lib/participants';
import { currentParticipant } from '../../../../../../lib/session';

// approve = pending/blocked -> approved; block covers both reject (pending)
// and revoke (approved). Participants never return to 'pending'.
const bodySchema = z.object({ status: z.enum(['approved', 'blocked']) });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ email: string }> },
): Promise<NextResponse> {
  try {
    const admin = requireAdmin(await currentParticipant());
    const target = decodeURIComponent((await ctx.params).email);
    const { status } = bodySchema.parse(await req.json());
    const updated = await setParticipantStatus(target, status, admin.email);
    if (!updated) return json({ error: 'participant not found' }, 404);
    return json({ participant: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
