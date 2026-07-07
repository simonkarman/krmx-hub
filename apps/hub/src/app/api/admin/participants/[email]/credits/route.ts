import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '../../../../../../lib/authz';
import { errorResponse, json } from '../../../../../../lib/http';
import { getBalance, getParticipant, grantCredits } from '../../../../../../lib/participants';
import { currentParticipant } from '../../../../../../lib/session';

const bodySchema = z.object({ amount: z.number().int().positive() });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ email: string }> },
): Promise<NextResponse> {
  try {
    requireAdmin(await currentParticipant());
    const target = decodeURIComponent((await ctx.params).email);
    const { amount } = bodySchema.parse(await req.json());
    if (!(await getParticipant(target))) return json({ error: 'participant not found' }, 404);
    await grantCredits(target, amount);
    return json({ email: target, balance: await getBalance(target) });
  } catch (error) {
    return errorResponse(error);
  }
}
