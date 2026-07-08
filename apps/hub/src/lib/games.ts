import { randomBytes } from 'node:crypto';
import { pool } from './db';

export type GameStatus = 'draft' | 'published' | 'suspended';
export type VersionStatus = 'active' | 'deprecated' | 'revoked';

export interface Game {
  id: string;
  hostEmail: string;
  name: string;
  description: string | null;
  status: GameStatus;
  entryFee: number;
}

export interface GameVersion {
  id: number;
  gameId: string;
  semver: string;
  frontendUrl: string;
  provisionUrl: string;
  maxPlayers: number;
  status: VersionStatus;
}

interface GameRow {
  id: string;
  host_email: string;
  name: string;
  description: string | null;
  status: GameStatus;
  entry_fee: number;
}

interface VersionRow {
  id: number;
  game_id: string;
  semver: string;
  frontend_url: string;
  provision_url: string;
  max_players: number;
  status: VersionStatus;
}

const toGame = (r: GameRow): Game => ({
  id: r.id,
  hostEmail: r.host_email,
  name: r.name,
  description: r.description,
  status: r.status,
  entryFee: r.entry_fee,
});

const toVersion = (r: VersionRow): GameVersion => ({
  id: r.id,
  gameId: r.game_id,
  semver: r.semver,
  frontendUrl: r.frontend_url,
  provisionUrl: r.provision_url,
  maxPlayers: r.max_players,
  status: r.status,
});

export async function getGame(id: string): Promise<Game | null> {
  const { rows } = await pool.query<GameRow>('SELECT * FROM game WHERE id = $1', [id]);
  return rows[0] ? toGame(rows[0]) : null;
}

/**
 * Creates a game and its per-game webhook secret (the HMAC key for provision
 * calls). The secret is returned exactly once to the owning host so they can
 * configure their provision endpoint; it is never logged (§9.13).
 */
export async function createGame(input: {
  id: string;
  hostEmail: string;
  name: string;
  description?: string | null;
  entryFee?: number;
}): Promise<{ game: Game; webhookSecret: string }> {
  const webhookSecret = randomBytes(32).toString('hex');
  const { rows } = await pool.query<GameRow>(
    `INSERT INTO game (id, host_email, name, description, webhook_secret, entry_fee)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.id, input.hostEmail, input.name, input.description ?? null, webhookSecret, input.entryFee ?? 0],
  );
  return { game: toGame(rows[0]!), webhookSecret };
}

export async function listPublishedGames(): Promise<Game[]> {
  const { rows } = await pool.query<GameRow>("SELECT * FROM game WHERE status = 'published' ORDER BY created_at");
  return rows.map(toGame);
}

export async function listGamesByHost(hostEmail: string): Promise<Game[]> {
  const { rows } = await pool.query<GameRow>('SELECT * FROM game WHERE host_email = $1 ORDER BY created_at', [
    hostEmail,
  ]);
  return rows.map(toGame);
}

export async function publishGame(id: string): Promise<Game | null> {
  const { rows } = await pool.query<GameRow>(
    "UPDATE game SET status = 'published' WHERE id = $1 AND status <> 'suspended' RETURNING *",
    [id],
  );
  return rows[0] ? toGame(rows[0]) : null;
}

export async function createGameVersion(input: {
  gameId: string;
  semver: string;
  frontendUrl: string;
  provisionUrl: string;
  maxPlayers?: number;
}): Promise<GameVersion> {
  // frontend_url is registered here and immutable — there is deliberately no
  // update path for it (§9.1/9.2: the framed origin is fixed at registration).
  const { rows } = await pool.query<VersionRow>(
    `INSERT INTO game_version (game_id, semver, frontend_url, provision_url, max_players)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.gameId, input.semver, input.frontendUrl, input.provisionUrl, input.maxPlayers ?? 2],
  );
  return toVersion(rows[0]!);
}

export async function listVersions(gameId: string): Promise<GameVersion[]> {
  const { rows } = await pool.query<VersionRow>(
    'SELECT * FROM game_version WHERE game_id = $1 ORDER BY id DESC',
    [gameId],
  );
  return rows.map(toVersion);
}

/** Resolves the version to provision from: an explicit id, else the latest active one. */
export async function resolveActiveVersion(gameId: string, versionId?: number): Promise<GameVersion | null> {
  if (versionId !== undefined) {
    const { rows } = await pool.query<VersionRow>(
      "SELECT * FROM game_version WHERE id = $1 AND game_id = $2 AND status = 'active'",
      [versionId, gameId],
    );
    return rows[0] ? toVersion(rows[0]) : null;
  }
  const { rows } = await pool.query<VersionRow>(
    "SELECT * FROM game_version WHERE game_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1",
    [gameId],
  );
  return rows[0] ? toVersion(rows[0]) : null;
}

/**
 * Resolves a version a provision response *named* by semver (§6.1 step 4). Only
 * an already-registered, active version resolves — a response can never name an
 * unregistered or revoked version into existence (P-04).
 */
export async function resolveActiveVersionBySemver(gameId: string, semver: string): Promise<GameVersion | null> {
  const { rows } = await pool.query<VersionRow>(
    "SELECT * FROM game_version WHERE game_id = $1 AND semver = $2 AND status = 'active'",
    [gameId, semver],
  );
  return rows[0] ? toVersion(rows[0]) : null;
}

/** The HMAC key for signing this game's provision call. Never logged (§9.13). */
export async function getWebhookSecret(gameId: string): Promise<string | null> {
  const { rows } = await pool.query<{ webhook_secret: string }>('SELECT webhook_secret FROM game WHERE id = $1', [
    gameId,
  ]);
  return rows[0]?.webhook_secret ?? null;
}
