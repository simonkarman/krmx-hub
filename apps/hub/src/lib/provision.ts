import {
  PROVISION_SIGNATURE_HEADER,
  PROVISION_TIMESTAMP_HEADER,
  provisionResponseSchema,
  type ProvisionResponse,
} from '@hub/protocol';
import { signProvisionBody } from '@hub/game-server-sdk';

export class ProvisionError extends Error {
  override name = 'ProvisionError';
  constructor(
    message: string,
    readonly kind: 'timeout' | 'transport' | 'response',
  ) {
    super(message);
  }
}

export function provisionTimeoutMs(): number {
  const raw = Number(process.env.PROVISION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000; // §6.1: 60s synchronous
}

/**
 * Calls a version's provision endpoint (ARCHITECTURE §6.1 step 3). The request
 * is HMAC-signed over `timestamp + "." + body` with the game's webhook_secret
 * (§9.14). The service token and secret never appear in logs or errors
 * (§9.13). The response is zod-parsed, which strips any `frontendUrl` a host
 * might try to inject (§9.2; P-03).
 */
export async function callProvision(input: {
  provisionUrl: string;
  webhookSecret: string;
  instanceId: string;
  serviceToken: string;
  hubUrl: string;
  timeoutMs?: number;
}): Promise<ProvisionResponse> {
  const body = JSON.stringify({
    instanceId: input.instanceId,
    serviceToken: input.serviceToken,
    hubUrl: input.hubUrl,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signProvisionBody(input.webhookSecret, timestamp, body);

  let res: Response;
  try {
    res = await fetch(input.provisionUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PROVISION_TIMESTAMP_HEADER]: String(timestamp),
        [PROVISION_SIGNATURE_HEADER]: signature,
      },
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? provisionTimeoutMs()),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ProvisionError('provision endpoint timed out', 'timeout'); // P-06
    }
    throw new ProvisionError('provision endpoint unreachable', 'transport');
  }

  if (!res.ok) {
    throw new ProvisionError(`provision endpoint returned ${res.status}`, 'response');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ProvisionError('provision response was not valid JSON', 'response');
  }
  const parsed = provisionResponseSchema.safeParse(json);
  if (!parsed.success) throw new ProvisionError('provision response failed schema validation', 'response');
  return parsed.data;
}
