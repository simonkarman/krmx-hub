'use client';

import { useState } from 'react';

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function HostConsole() {
  const [secret, setSecret] = useState<string | null>(null);

  async function createGame(form: FormData) {
    const res = await postJson('/api/games', {
      id: String(form.get('id')),
      name: String(form.get('name')),
      entryFee: Number(form.get('entryFee') || 0),
    });
    const data = await res.json();
    if (!res.ok) return alert(`Failed: ${data.error ?? res.status}`);
    // Shown once — the host needs it to configure their provision endpoint.
    setSecret(data.webhookSecret);
    location.reload();
  }

  async function addVersion(form: FormData) {
    const gameId = String(form.get('gameId'));
    const res = await postJson(`/api/games/${encodeURIComponent(gameId)}/versions`, {
      semver: String(form.get('semver')),
      frontendUrl: String(form.get('frontendUrl')),
      provisionUrl: String(form.get('provisionUrl')),
      maxPlayers: Number(form.get('maxPlayers') || 2),
    });
    const data = await res.json();
    if (!res.ok) return alert(`Failed: ${data.error ?? res.status}`);
    location.reload();
  }

  async function publish(form: FormData) {
    const gameId = String(form.get('gameId'));
    const res = await postJson(`/api/games/${encodeURIComponent(gameId)}/publish`, {});
    if (!res.ok) return alert(`Failed: ${(await res.json()).error ?? res.status}`);
    location.reload();
  }

  return (
    <div>
      <h2>Register a game</h2>
      {secret ? (
        <p style={{ color: 'darkgreen' }}>
          Webhook secret (shown once — configure your provisioner with it): <code>{secret}</code>
        </p>
      ) : null}
      <form action={createGame}>
        <input name="id" placeholder="slug (e.g. tictactoe)" required />{' '}
        <input name="name" placeholder="Display name" required />{' '}
        <input name="entryFee" type="number" min={0} defaultValue={0} style={{ width: '5em' }} />{' '}
        <button type="submit">Create game</button>
      </form>

      <h2>Add a version</h2>
      <form action={addVersion}>
        <input name="gameId" placeholder="game id" required />{' '}
        <input name="semver" placeholder="1.0.0" required />{' '}
        <input name="frontendUrl" placeholder="http://localhost:4000" required />{' '}
        <input name="provisionUrl" placeholder="http://localhost:4100/provision" required />{' '}
        <input name="maxPlayers" type="number" min={1} defaultValue={2} style={{ width: '4em' }} title="max players" />{' '}
        <button type="submit">Add version</button>
      </form>

      <h2>Publish</h2>
      <form action={publish}>
        <input name="gameId" placeholder="game id" required /> <button type="submit">Publish game</button>
      </form>
    </div>
  );
}
