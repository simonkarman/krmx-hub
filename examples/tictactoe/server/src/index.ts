import { WebSocketServer } from 'ws';

/**
 * Placeholder game server (M3). Binds the port the provisioner assigned so the
 * hub's opaque `serverUrl` resolves to something real, and sends heartbeats to
 * the hub service API to stay out of the reaper. The real Krmx server + ticket
 * authentication via @hub/krmx-adapter lands in M5.
 */
const port = Number(process.env.GAME_PORT ?? 0);
const instanceId = process.env.INSTANCE_ID;
const hubUrl = process.env.HUB_URL;
const serviceToken = process.env.SERVICE_TOKEN;

const wss = new WebSocketServer({ port });
wss.on('listening', () => console.log(`tictactoe placeholder server listening on ws://localhost:${port}`));
wss.on('connection', (socket) => socket.send(JSON.stringify({ type: 'placeholder:hello', instanceId })));

async function heartbeat(): Promise<void> {
  if (!hubUrl || !instanceId || !serviceToken) return;
  try {
    await fetch(`${hubUrl}/api/service/instances/${instanceId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify({ status: 'lobby' }),
    });
  } catch {
    // best-effort in the placeholder
  }
}

void heartbeat();
setInterval(heartbeat, 60_000).unref();
