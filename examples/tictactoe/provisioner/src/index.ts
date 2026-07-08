import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVISION_SIGNATURE_HEADER,
  PROVISION_TIMESTAMP_HEADER,
  provisionRequestSchema,
} from '@hub/protocol';
import { verifyProvisionRequest } from '@hub/game-server-sdk';

/**
 * Local (Phase 0) provisioner for the tictactoe example. Verifies the hub's
 * HMAC-signed provision call (P-01, P-02), spawns a placeholder game-server
 * child process on a free port, and returns `ws://localhost:<port>`. In M7
 * this becomes a Cloud Run deploy of a pinned image.
 *
 * The webhook secret is shared out-of-band with the hub (env WEBHOOK_SECRET);
 * it must equal the secret the hub generated for this game. Never logged.
 */
const PORT = Number(process.env.PORT ?? 4100);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error('provisioner: WEBHOOK_SECRET env var is required');
  process.exit(1);
}

const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/dist/index.js');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/provision')) {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    void handleProvision(req, res, Buffer.concat(chunks).toString('utf8'));
  });
});

async function handleProvision(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  rawBody: string,
): Promise<void> {
  const verdict = verifyProvisionRequest({
    secret: WEBHOOK_SECRET!,
    timestamp: header(req, PROVISION_TIMESTAMP_HEADER),
    signature: header(req, PROVISION_SIGNATURE_HEADER),
    body: rawBody,
  });
  if (!verdict.ok) {
    // Only a genuinely stale-but-signed call is a timeout; missing/bad
    // timestamp or signature is unauthorized.
    res.writeHead(verdict.reason === 'stale' ? 408 : 401).end(JSON.stringify({ error: verdict.reason }));
    return;
  }

  const parsed = provisionRequestSchema.safeParse(safeJson(rawBody));
  if (!parsed.success) {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid provision body' }));
    return;
  }

  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      GAME_PORT: String(port),
      INSTANCE_ID: parsed.data.instanceId,
      HUB_URL: parsed.data.hubUrl,
      // The service token is passed to the child via env, never via argv/log (§9.13).
      SERVICE_TOKEN: parsed.data.serviceToken,
    },
    stdio: 'inherit',
    detached: false,
  });
  child.on('error', (err) => console.error('failed to spawn game server:', err.message));

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ serverUrl: `ws://localhost:${port}` }));
}

function header(req: import('node:http').IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

server.listen(PORT, () => console.log(`tictactoe provisioner listening on http://localhost:${PORT}/provision`));
