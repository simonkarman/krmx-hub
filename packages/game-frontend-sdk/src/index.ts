import { gameToHubMessageSchema, hubToGameMessageSchema, PROTOCOL_VERSION, type HubToGameMessage } from '@hub/protocol';

/**
 * @hub/game-frontend-sdk — the game frontend's side of the embedding contract
 * (ARCHITECTURE §6.3, §7). Runs inside the hub's sandboxed iframe.
 *
 * Origin pinning, both directions:
 *  - The hub origin is taken from the browser-provided ancestor origin (the
 *    real embedding origin, not spoofable by page script), or an explicit
 *    override. Every outbound postMessage targets exactly that origin, and
 *    every inbound message whose `event.origin` differs is ignored (F-01/F-02).
 *  - Every inbound message is zod-parsed; malformed ones are dropped (F-07).
 *
 * Tickets arrive only via postMessage, never a URL (§9.3).
 */

export interface HubSession {
  readonly instanceId: string;
  readonly username: string;
  /** Current player ticket (RS256 JWT, aud = instance:<id>). */
  readonly ticket: string;
  /** Opaque transport endpoint to connect the game to. */
  readonly serverUrl: string;
  /** Request a fresh ticket after expiry; resolves with the new ticket (§6.3 step 5). */
  requestTicket(): Promise<string>;
  /** Subscribe to ticket refreshes (e.g. to re-link a reconnecting client). */
  onTicket(listener: (ticket: string) => void): void;
  /** Tell the hub the user is done; the hub navigates away. */
  exit(): void;
}

export interface ConnectOptions {
  /** Trusted hub origin. Defaults to the browser-reported embedding origin. */
  hubOrigin?: string;
  /** How long to wait for the first hub:init before rejecting. */
  timeoutMs?: number;
}

function resolveHubOrigin(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const ancestors = window.location.ancestorOrigins;
  return ancestors && ancestors.length > 0 ? ancestors[0] : undefined;
}

export function connectToHub(options: ConnectOptions = {}): Promise<HubSession> {
  const hubOrigin = resolveHubOrigin(options.hubOrigin);
  if (!hubOrigin) {
    return Promise.reject(new Error('cannot determine hub origin (frontend not embedded by a hub?)'));
  }
  const parent = window.parent;
  if (parent === window) {
    return Promise.reject(new Error('frontend is not running inside a hub iframe'));
  }

  const ticketListeners = new Set<(ticket: string) => void>();
  let pendingTicket: ((ticket: string) => void) | null = null;
  let current: { instanceId: string; username: string; ticket: string; serverUrl: string } | null = null;

  const post = (message: unknown) => parent.postMessage(message, hubOrigin);

  return new Promise<HubSession>((resolve, reject) => {
    // Re-announce readiness until the hub answers: the hub's listener may not be
    // attached yet when we first post, and hub:ready carries no secret.
    let readyPing: ReturnType<typeof setInterval> | undefined;
    const stopPinging = () => {
      if (readyPing) clearInterval(readyPing);
      readyPing = undefined;
    };
    const timer = setTimeout(() => {
      stopPinging();
      window.removeEventListener('message', onMessage);
      reject(new Error('timed out waiting for hub:init'));
    }, options.timeoutMs ?? 10_000);

    function applyInit(init: Extract<HubToGameMessage, { type: 'hub:init' }>) {
      current = {
        instanceId: init.instanceId,
        username: init.username,
        ticket: init.ticket,
        serverUrl: init.serverUrl,
      };
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== hubOrigin) return; // F-01, F-02
      const parsed = hubToGameMessageSchema.safeParse(event.data); // F-07
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type !== 'hub:init') return;

      applyInit(message);
      if (pendingTicket) {
        const notify = pendingTicket;
        pendingTicket = null;
        notify(message.ticket);
      }
      for (const listener of ticketListeners) listener(message.ticket);

      // first init resolves the connection
      clearTimeout(timer);
      stopPinging();
      resolve({
        instanceId: message.instanceId,
        username: message.username,
        get ticket() {
          return current!.ticket;
        },
        serverUrl: message.serverUrl,
        requestTicket() {
          return new Promise<string>((res) => {
            pendingTicket = res;
            post({ type: 'hub:request-ticket' } satisfies { type: 'hub:request-ticket' });
          });
        },
        onTicket(listener) {
          ticketListeners.add(listener);
        },
        exit() {
          post({ type: 'hub:exit' } satisfies { type: 'hub:exit' });
        },
      });
    }

    window.addEventListener('message', onMessage);
    // Announce readiness (validate our own outbound shape defensively), then
    // keep re-announcing until the hub responds with hub:init.
    const ready = { type: 'hub:ready' as const };
    gameToHubMessageSchema.parse(ready);
    post(ready);
    readyPing = setInterval(() => post(ready), 250);
  });
}

export { PROTOCOL_VERSION };
