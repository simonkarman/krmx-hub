import type { NextResponse } from 'next/server';
import { publishGame } from '../../../../../lib/games';
import { requireOwnedGame } from '../../../../../lib/host-guard';
import { errorResponse, json } from '../../../../../lib/http';
import { currentParticipant } from '../../../../../lib/session';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  try {
    const { gameId } = await ctx.params;
    const game = await requireOwnedGame(await currentParticipant(), gameId); // A-06, A-07
    if (!game) return json({ error: 'game not found' }, 404);
    const published = await publishGame(gameId);
    if (!published) return json({ error: 'game cannot be published' }, 409);
    return json({ game: published });
  } catch (error) {
    return errorResponse(error);
  }
}
