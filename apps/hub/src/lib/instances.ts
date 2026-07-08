import { pool } from './db';

export type InstanceStatus = 'provisioning' | 'lobby' | 'running' | 'finished' | 'cancelled';

export interface Instance {
  id: string;
  gameVersionId: number;
  createdBy: string;
  visibility: 'private' | 'public';
  inviteCode: string | null;
  status: InstanceStatus;
  serverUrl: string | null;
}

interface InstanceRow {
  id: string;
  game_version_id: number;
  created_by: string;
  visibility: 'private' | 'public';
  invite_code: string | null;
  status: InstanceStatus;
  server_url: string | null;
}

export async function getInstance(id: string): Promise<Instance | null> {
  const { rows } = await pool.query<InstanceRow>('SELECT * FROM instance WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    gameVersionId: row.game_version_id,
    createdBy: row.created_by,
    visibility: row.visibility,
    inviteCode: row.invite_code,
    status: row.status,
    serverUrl: row.server_url,
  };
}

export interface PlayableInstance {
  status: InstanceStatus;
  frontendUrl: string;
  serverUrl: string | null;
}

/** Instance play info joined with its registered frontend_url (§6.3 step 1). */
export async function getPlayableInstance(id: string): Promise<PlayableInstance | null> {
  const { rows } = await pool.query<{ status: InstanceStatus; frontend_url: string; server_url: string | null }>(
    `SELECT i.status, i.server_url, gv.frontend_url
       FROM instance i JOIN game_version gv ON gv.id = i.game_version_id
      WHERE i.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return { status: row.status, frontendUrl: row.frontend_url, serverUrl: row.server_url };
}

export interface PlayerInstanceSummary {
  id: string;
  status: InstanceStatus;
  gameName: string;
}

/** Instances the participant is seated in (for the home lobby). */
export async function listInstancesForPlayer(email: string): Promise<PlayerInstanceSummary[]> {
  const { rows } = await pool.query<{ id: string; status: InstanceStatus; game_name: string }>(
    `SELECT i.id, i.status, g.name AS game_name
       FROM instance_player ip
       JOIN instance i ON i.id = ip.instance_id
       JOIN game_version gv ON gv.id = i.game_version_id
       JOIN game g ON g.id = gv.game_id
      WHERE ip.email = $1
      ORDER BY i.created_at DESC
      LIMIT 20`,
    [email],
  );
  return rows.map((r) => ({ id: r.id, status: r.status, gameName: r.game_name }));
}

export async function isInstancePlayer(instanceId: string, email: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM instance_player WHERE instance_id = $1 AND email = $2', [
    instanceId,
    email,
  ]);
  return (rowCount ?? 0) > 0;
}
