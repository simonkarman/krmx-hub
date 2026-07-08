import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireHost } from '../../../lib/authz';
import { createGame, getGame, listPublishedGames } from '../../../lib/games';
import { errorResponse, json } from '../../../lib/http';
import { currentParticipant } from '../../../lib/session';

// Public catalog of published games (§2 anonymous browse). No secrets exposed.
export async function GET(): Promise<NextResponse> {
  try {
    const games = await listPublishedGames();
    return json({ games: games.map(({ id, name, description, entryFee }) => ({ id, name, description, entryFee })) });
  } catch (error) {
    return errorResponse(error);
  }
}

const createSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  entryFee: z.number().int().min(0).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const host = requireHost(await currentParticipant()); // A-06
    const input = createSchema.parse(await req.json());
    if (await getGame(input.id)) return json({ error: 'game id already taken' }, 409);

    const { game, webhookSecret } = await createGame({ ...input, hostEmail: host.email });
    // webhookSecret is returned to the owning host exactly once (never logged).
    return json({ game, webhookSecret }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
