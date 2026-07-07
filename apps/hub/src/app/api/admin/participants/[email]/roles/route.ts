import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '../../../../../../lib/authz';
import { errorResponse, json } from '../../../../../../lib/http';
import { grantRole, revokeRole } from '../../../../../../lib/participants';
import { currentParticipant } from '../../../../../../lib/session';

const bodySchema = z.object({
  role: z.enum(['host', 'admin']),
  op: z.enum(['grant', 'revoke']),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ email: string }> },
): Promise<NextResponse> {
  try {
    requireAdmin(await currentParticipant());
    const target = decodeURIComponent((await ctx.params).email);
    const { role, op } = bodySchema.parse(await req.json());
    const updated = op === 'grant' ? await grantRole(target, role) : await revokeRole(target, role);
    if (!updated) return json({ error: 'participant not found' }, 404);
    return json({ participant: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
