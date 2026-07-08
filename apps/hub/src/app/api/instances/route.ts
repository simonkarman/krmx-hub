import { createHash, randomBytes } from 'node:crypto';
import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApproved } from '../../../lib/authz';
import { pool } from '../../../lib/db';
import { getGame, getWebhookSecret, resolveActiveVersion, resolveActiveVersionBySemver } from '../../../lib/games';
import { errorResponse, json } from '../../../lib/http';
import { newInstanceId, newInviteCode } from '../../../lib/ids';
import { callProvision, ProvisionError } from '../../../lib/provision';
import { hubIssuer } from '../../../lib/tickets';
import { currentParticipant } from '../../../lib/session';

const createSchema = z.object({
  gameId: z.string().min(1),
  versionId: z.number().int().positive().optional(),
  visibility: z.enum(['private', 'public']).optional(),
});

/**
 * Creates and provisions an instance (ARCHITECTURE §6.1).
 *
 * Invariant-critical handling (review focus §9.1, §9.2, §9.8):
 *  - The service token is opaque 256-bit random; only its sha256 hash is
 *    stored (§5; H-03). The plaintext goes only to the provision endpoint.
 *  - The provision response's `serverUrl` is stored opaquely; any `frontendUrl`
 *    it carries was already stripped by the schema (§9.2; P-03).
 *  - A response may only *name* an already-registered active version; an
 *    unregistered/revoked name fails the whole creation (§9.1; P-04).
 *  - Provision failure/timeout cancels the instance (P-06). Hold release is
 *    TODO(M4); M3 writes no holds, so nothing is stranded (§9.8).
 */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    const participant = requireApproved(await currentParticipant());
    const input = createSchema.parse(await req.json());

    const game = await getGame(input.gameId);
    if (!game || game.status !== 'published') return json({ error: 'game not available' }, 404);

    const version = await resolveActiveVersion(input.gameId, input.versionId);
    if (!version) return json({ error: 'no active version to provision' }, 400);

    const webhookSecret = await getWebhookSecret(input.gameId);
    if (!webhookSecret) return json({ error: 'game misconfigured' }, 500);

    // TODO(M4): require balance >= game.entryFee and write the creator's
    // entry_hold in the same transaction as the insert below (§6.1 step 2).

    const instanceId = newInstanceId();
    const serviceToken = randomBytes(32).toString('hex');
    const serviceTokenHash = createHash('sha256').update(serviceToken).digest('hex');
    await pool.query(
      `INSERT INTO instance (id, game_version_id, created_by, visibility, status, service_token_hash)
       VALUES ($1, $2, $3, $4, 'provisioning', $5)`,
      [instanceId, version.id, participant.email, input.visibility ?? 'private', serviceTokenHash],
    );

    let serverUrl: string;
    let framedVersionId = version.id;
    try {
      const result = await callProvision({
        provisionUrl: version.provisionUrl,
        webhookSecret,
        instanceId,
        serviceToken,
        hubUrl: hubIssuer(),
      });
      serverUrl = result.serverUrl;

      if (result.version !== undefined) {
        const named = await resolveActiveVersionBySemver(input.gameId, result.version);
        if (!named) {
          // §9.2/§9.1: response named a version the hub does not have active.
          await cancelInstance(instanceId);
          return json({ error: 'provision named an unregistered or revoked version' }, 502); // P-04
        }
        framedVersionId = named.id;
      }
    } catch (error) {
      await cancelInstance(instanceId);
      if (error instanceof ProvisionError) {
        return json({ error: 'provisioning failed', kind: error.kind }, 502); // P-06 (timeout), transport, response
      }
      throw error;
    }

    const inviteCode = newInviteCode();
    await pool.query(
      `UPDATE instance
         SET status = 'lobby', server_url = $2, game_version_id = $3,
             invite_code = $4, last_heartbeat_at = now()
       WHERE id = $1`,
      [instanceId, serverUrl, framedVersionId, inviteCode],
    );

    return json({ instanceId, status: 'lobby', inviteCode }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function cancelInstance(instanceId: string): Promise<void> {
  // TODO(M4): release the creator's entry_hold here too.
  await pool.query(
    "UPDATE instance SET status = 'cancelled', ended_at = now() WHERE id = $1 AND status = 'provisioning'",
    [instanceId],
  );
}
