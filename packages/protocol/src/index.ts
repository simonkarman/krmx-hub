import { z } from 'zod';

/**
 * @hub/protocol — the platform API surface (ARCHITECTURE §4, §6.4, §7).
 * Transport-agnostic: nothing here assumes Krmx. Keep minimal and exact.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Player tickets are short-lived by design (§4): 2 minutes + verifier skew. */
export const TICKET_LIFETIME_SECONDS = 120;

/** The `aud` claim scoping a ticket to exactly one instance (§4; T-05). */
export type InstanceAudience = `instance:${string}`;

export function instanceAudience(instanceId: string): InstanceAudience {
  return `instance:${instanceId}`;
}

/** Player ticket claims (§4). Minted only by the hub, RS256 only (§9.6). */
export const ticketClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1), // participant email
  aud: z.string().startsWith('instance:'),
  name: z.string().min(1), // username the player must connect with (T-06)
  jti: z.string().min(1), // single-use id (§9.11; T-08)
  iat: z.number().int(),
  exp: z.number().int(),
});
export type TicketClaims = z.infer<typeof ticketClaimsSchema>;

// postMessage embedding contract (§7). Both sides zod-parse every inbound
// message (F-07) and pin origins; tickets travel only here, never in URLs (§9.3).

export const gameToHubMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hub:ready') }).strict(),
  z.object({ type: z.literal('hub:request-ticket') }).strict(),
  z.object({ type: z.literal('hub:exit') }).strict(),
]);
export type GameToHubMessage = z.infer<typeof gameToHubMessageSchema>;

export const hubToGameMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hub:init'),
      protocolVersion: z.literal(PROTOCOL_VERSION),
      instanceId: z.string().min(1),
      username: z.string().min(1),
      ticket: z.string().min(1), // RS256 JWT, aud = instance:<instanceId>
      serverUrl: z.string().min(1), // opaque transport endpoint
    })
    .strict(),
]);
export type HubToGameMessage = z.infer<typeof hubToGameMessageSchema>;

// Service API shapes (§6.4). Auth: `Authorization: Bearer <service token>`,
// scoped to exactly one instance (§9.5). Endpoints land in M3/M4.

export const heartbeatRequestSchema = z.object({
  status: z.enum(['lobby', 'running']),
  /** Optional opaque snapshot for hub-side lobby display; the hub is never authoritative for game state. */
  state: z.unknown().optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const resultsRequestSchema = z.object({
  /** Participant emails, winner first. Settlement validates every entry is a player (S-06). */
  ranking: z.array(z.string().min(1)).min(1),
});
export type ResultsRequest = z.infer<typeof resultsRequestSchema>;
