import { AuthzError, requireHost } from './authz';
import { getGame, type Game } from './games';
import type { Participant } from './participants';

/**
 * Resolves a game the caller is allowed to manage: host role (A-06) AND
 * ownership of this specific game (A-07). Throws AuthzError; the 404 for a
 * missing game is surfaced by the caller.
 */
export async function requireOwnedGame(participant: Participant | null, gameId: string): Promise<Game | null> {
  const host = requireHost(participant);
  const game = await getGame(gameId);
  if (!game) return null;
  if (game.hostEmail !== host.email) throw new AuthzError(403, 'not your game');
  return game;
}
