import { createClient } from '@krmx/client';
import { connectToHub } from '@hub/game-frontend-sdk';

/**
 * Tic-tac-toe frontend (ARCHITECTURE §6.3 steps 2-5). Gets its ticket, server
 * URL and username from the hub via connectToHub (postMessage, origin-pinned),
 * then drives a @krmx/client against the game server. On a rejected link
 * (expired/used ticket) it fetches a fresh ticket via hub:request-ticket and
 * re-links — the reconnect path.
 */
type State = {
  board: (string | null)[];
  players: { username: string; symbol: string }[];
  turn: string | null;
  winner: string | null;
  draw: boolean;
};

const root = document.getElementById('app')!;
const status = document.getElementById('status')!;

function render(state: State, me: string) {
  const mySymbol = state.players.find((p) => p.username === me)?.symbol ?? '?';
  root.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'board';
  state.board.forEach((cell, i) => {
    const btn = document.createElement('button');
    btn.className = 'cell';
    btn.dataset.cell = String(i);
    btn.textContent = cell ?? '';
    btn.disabled = cell !== null || state.turn !== me || !!state.winner || state.draw;
    btn.addEventListener('click', () => client.send({ type: 'ttt/move', payload: { cell: i } }));
    grid.appendChild(btn);
  });
  root.appendChild(grid);

  if (state.winner) status.textContent = state.winner === me ? 'You win!' : 'You lose.';
  else if (state.draw) status.textContent = 'Draw.';
  else if (state.players.length < 2) status.textContent = `Waiting for opponent… (you are ${mySymbol})`;
  else status.textContent = state.turn === me ? `Your move (${mySymbol})` : 'Opponent’s move…';
}

const client = createClient({ logger: false });
let me = '';

// Minimal, non-secret hooks for the security harness: readiness + a ticket
// counter. The ticket value itself is deliberately never exposed (F-04).
interface HubTestHooks {
  ready: boolean;
  instanceId?: string;
  username?: string;
  ticketCount: number;
  error?: string;
}
const hooks: HubTestHooks = { ready: false, ticketCount: 0 };
(window as unknown as { __hub: HubTestHooks }).__hub = hooks;

async function main() {
  const session = await connectToHub();
  me = session.username;
  hooks.ready = true;
  hooks.instanceId = session.instanceId;
  hooks.username = session.username;
  hooks.ticketCount = 1;
  session.onTicket(() => {
    hooks.ticketCount += 1;
  });
  status.textContent = 'Connecting…';

  client.on('message', (message) => {
    if (message.type === 'ttt/state') render(message.payload as State, me);
  });

  // Reconnect path: a rejected link usually means the ticket expired or was
  // already used — request a fresh one and re-link (§6.3 step 5).
  let relinking = false;
  client.on('reject', async () => {
    if (relinking) return;
    relinking = true;
    try {
      const fresh = await session.requestTicket();
      await client.link(session.username, fresh);
    } finally {
      relinking = false;
    }
  });

  await client.connect(session.serverUrl);
  await client.link(session.username, session.ticket);
}

main().catch((err) => {
  hooks.error = err instanceof Error ? err.message : String(err);
  status.textContent = `Error: ${hooks.error}`;
});
