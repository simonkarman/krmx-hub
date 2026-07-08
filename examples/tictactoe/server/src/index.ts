import { createServer } from '@krmx/server';
import { useHubAuthentication } from '@hub/krmx-adapter';

/**
 * Tic-tac-toe game server (ARCHITECTURE §6.3, §6.4). Ticket authentication is
 * delegated to @hub/krmx-adapter; game state lives here (the hub is never
 * authoritative for it). On a win, results are posted to the hub service API
 * with this instance's service token, which the hub settles into payouts.
 *
 * Env is supplied by the provisioner (M3): GAME_PORT, INSTANCE_ID, HUB_URL,
 * SERVICE_TOKEN.
 */
const port = Number(process.env.GAME_PORT ?? 0);
const instanceId = process.env.INSTANCE_ID ?? 'dev';
const hubUrl = process.env.HUB_URL ?? 'http://localhost:3000';
const serviceToken = process.env.SERVICE_TOKEN ?? '';

const LINES: [number, number, number][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

interface Player {
  username: string;
  symbol: 'X' | 'O';
}

const board: (string | null)[] = Array(9).fill(null);
const players: Player[] = [];
let turn: string | null = null;
let winner: string | null = null;
let draw = false;
let settled = false;

const server = createServer({ logger: false });
useHubAuthentication(server, { hubUrl, instanceId });

const symbolOf = (username: string) => players.find((p) => p.username === username)?.symbol;
const state = () => ({ board, players, turn, winner, draw });
const broadcast = () => server.broadcast({ type: 'ttt/state', payload: state() });

function winningSymbol(): 'X' | 'O' | null {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a] as 'X' | 'O';
  }
  return null;
}

server.on('link', (username) => {
  if (!players.some((p) => p.username === username) && players.length < 2) {
    players.push({ username, symbol: players.length === 0 ? 'X' : 'O' });
    if (players.length === 2) turn = players[0]!.username; // X starts
  }
  broadcast();
});

server.on('message', (username, message) => {
  if (message.type !== 'ttt/move' || winner || draw || turn !== username) return;
  const cell = (message.payload as { cell?: unknown })?.cell;
  if (typeof cell !== 'number' || cell < 0 || cell > 8 || board[cell]) return;

  board[cell] = symbolOf(username)!;
  const won = winningSymbol();
  if (won) winner = players.find((p) => p.symbol === won)!.username;
  else if (board.every(Boolean)) draw = true;
  else turn = players.find((p) => p.username !== username)!.username;

  broadcast();
  if (winner) void settle();
});

async function settle(): Promise<void> {
  if (settled) return;
  settled = true;
  const loser = players.find((p) => p.username !== winner)?.username;
  const ranking = [winner, loser].filter((u): u is string => Boolean(u));
  try {
    await fetch(`${hubUrl}/api/service/instances/${instanceId}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify({ ranking }),
    });
  } catch {
    // best-effort; the reaper will clean up if the hub was unreachable
  }
}

async function heartbeat(): Promise<void> {
  if (!serviceToken) return;
  try {
    await fetch(`${hubUrl}/api/service/instances/${instanceId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify({ status: winner || draw ? 'running' : 'lobby' }),
    });
  } catch {
    // best-effort
  }
}

await server.listen(port);
void heartbeat();
setInterval(heartbeat, 30_000).unref();
