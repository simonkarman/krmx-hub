import { createHash, timingSafeEqual } from 'node:crypto';
import { pool } from './db';

export interface ServiceAuthOk {
  instanceId: string;
  status: string;
}

export type ServiceAuthResult = { ok: true; instance: ServiceAuthOk } | { ok: false; status: 401 | 403 };

/** Service tokens arrive ONLY in the Authorization header, never a query param (§9.13; S-07). */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1]! : null;
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Authenticates a service-API caller (ARCHITECTURE §9.5). The stored column is
 * only ever a sha256 hash (§5; H-03), so we hash the presented token and look
 * up its owning instance, then compare in constant time. A service token
 * authorizes exactly its own, still-live instance:
 *   - unknown token                       → 401 (S-04)
 *   - token of a finished/cancelled inst  → 401 revoked (S-02, S-03)
 *   - valid token, but for another :id    → 403 (S-01)
 */
export async function authenticateService(req: Request, pathInstanceId: string): Promise<ServiceAuthResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401 };

  const hash = sha256hex(token);
  const { rows } = await pool.query<{ id: string; status: string; service_token_hash: string }>(
    'SELECT id, status, service_token_hash FROM instance WHERE service_token_hash = $1',
    [hash],
  );
  const inst = rows[0];
  if (!inst) return { ok: false, status: 401 };

  const a = Buffer.from(hash);
  const b = Buffer.from(inst.service_token_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401 };

  if (inst.status === 'finished' || inst.status === 'cancelled') return { ok: false, status: 401 };
  if (inst.id !== pathInstanceId) return { ok: false, status: 403 };

  return { ok: true, instance: { instanceId: inst.id, status: inst.status } };
}
