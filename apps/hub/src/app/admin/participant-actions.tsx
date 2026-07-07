'use client';

import { useState } from 'react';

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    alert(`Request failed with status ${res.status}`);
  }
  location.reload();
}

export function ParticipantActions({ email }: { email: string }) {
  const [amount, setAmount] = useState(10);
  const base = `/api/admin/participants/${encodeURIComponent(email)}`;
  return (
    <span>
      <button onClick={() => post(`${base}/status`, { status: 'approved' })}>Approve</button>{' '}
      <button onClick={() => post(`${base}/status`, { status: 'blocked' })}>Block</button>{' '}
      <button onClick={() => post(`${base}/roles`, { role: 'host', op: 'grant' })}>+host</button>{' '}
      <button onClick={() => post(`${base}/roles`, { role: 'host', op: 'revoke' })}>-host</button>{' '}
      <button onClick={() => post(`${base}/roles`, { role: 'admin', op: 'grant' })}>+admin</button>{' '}
      <button onClick={() => post(`${base}/roles`, { role: 'admin', op: 'revoke' })}>-admin</button>{' '}
      <input
        type="number"
        min={1}
        step={1}
        value={amount}
        onChange={(e) => setAmount(Number(e.target.value))}
        style={{ width: '5em' }}
      />{' '}
      <button onClick={() => post(`${base}/credits`, { amount })}>Grant credits</button>
    </span>
  );
}
