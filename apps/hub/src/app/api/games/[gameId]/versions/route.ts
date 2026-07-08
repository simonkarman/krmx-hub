import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { createGameVersion, listVersions } from '../../../../../lib/games';
import { requireOwnedGame } from '../../../../../lib/host-guard';
import { errorResponse, json } from '../../../../../lib/http';
import { currentParticipant } from '../../../../../lib/session';

const createSchema = z.object({
  semver: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'semver must be MAJOR.MINOR.PATCH'),
  // frontend_url is registered here and becomes immutable (§9.1/9.2).
  frontendUrl: z.string().url(),
  provisionUrl: z.string().url(),
  maxPlayers: z.number().int().min(1).max(64).optional(),
});

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  try {
    const { gameId } = await ctx.params;
    const game = await requireOwnedGame(await currentParticipant(), gameId); // A-06, A-07
    if (!game) return json({ error: 'game not found' }, 404);
    return json({ versions: await listVersions(gameId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  try {
    const { gameId } = await ctx.params;
    const game = await requireOwnedGame(await currentParticipant(), gameId); // A-06, A-07
    if (!game) return json({ error: 'game not found' }, 404);

    const input = createSchema.parse(await req.json());
    try {
      const version = await createGameVersion({ gameId, ...input });
      return json({ version }, 201);
    } catch (err) {
      // UNIQUE (game_id, semver)
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
        return json({ error: 'semver already registered for this game' }, 409);
      }
      throw err;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
