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

export async function isInstancePlayer(instanceId: string, email: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM instance_player WHERE instance_id = $1 AND email = $2', [
    instanceId,
    email,
  ]);
  return (rowCount ?? 0) > 0;
}
