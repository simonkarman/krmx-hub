'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Minimal lobby controls: create an instance of a published game (which
 * provisions a server) and jump into it, or join an existing one by id.
 */
export function CreateInstanceButton({ gameId }: { gameId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Could not create: ${data.error ?? res.status}`);
        return;
      }
      router.push(`/play/${data.instanceId}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button onClick={create} disabled={busy}>
      {busy ? 'Creating…' : 'Create & play'}
    </button>
  );
}

export function JoinByIdForm() {
  const router = useRouter();
  async function join(form: FormData) {
    const id = String(form.get('id')).trim();
    if (!id) return;
    const res = await fetch(`/api/instances/${encodeURIComponent(id)}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      alert(`Could not join: ${(await res.json()).error ?? res.status}`);
      return;
    }
    router.push(`/play/${id}`);
  }
  return (
    <form action={join}>
      <input name="id" placeholder="instance id" /> <button type="submit">Join</button>
    </form>
  );
}
