import Link from 'next/link';
import { signOut } from '../auth';
import { getBalance, listLedger } from '../lib/participants';
import { currentParticipant } from '../lib/session';

function SignOutButton() {
  return (
    <form
      action={async () => {
        'use server';
        await signOut({ redirectTo: '/' });
      }}
    >
      <button type="submit">Sign out</button>
    </form>
  );
}

export default async function HomePage() {
  const participant = await currentParticipant();

  if (!participant) {
    return (
      <main>
        <h1>Krmx Hub</h1>
        <p>The public game catalog arrives in M3.</p>
        <p>
          <Link href="/signin">Sign in</Link>
        </p>
      </main>
    );
  }

  if (participant.status === 'pending') {
    return (
      <main>
        <h1>Krmx Hub</h1>
        <p>
          Signed in as {participant.email}. Your account is <strong>waiting for approval</strong> by an
          admin — check back later.
        </p>
        <SignOutButton />
      </main>
    );
  }

  if (participant.status === 'blocked') {
    return (
      <main>
        <h1>Krmx Hub</h1>
        <p>Signed in as {participant.email}. Your account has been blocked.</p>
        <SignOutButton />
      </main>
    );
  }

  const [balance, ledger] = await Promise.all([getBalance(participant.email), listLedger(participant.email)]);
  return (
    <main>
      <h1>Krmx Hub</h1>
      <p>
        Signed in as {participant.email}
        {participant.roles.length > 0 ? ` (${participant.roles.join(', ')})` : ''}.
      </p>
      <p>
        <strong>Credits: {balance}</strong> (balance is the sum of the ledger below, including active holds)
      </p>
      {ledger.length > 0 ? (
        <table border={1} cellPadding={4}>
          <thead>
            <tr>
              <th>type</th>
              <th>amount</th>
              <th>instance</th>
              <th>when</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((entry, i) => (
              <tr key={i}>
                <td>{entry.type}</td>
                <td>{entry.amount > 0 ? `+${entry.amount}` : entry.amount}</td>
                <td>{entry.instanceId ?? '—'}</td>
                <td>{entry.createdAt.toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p>
        {participant.roles.includes('admin') ? <Link href="/admin">Admin dashboard</Link> : null}
        {participant.roles.includes('admin') && participant.roles.includes('host') ? ' · ' : ''}
        {participant.roles.includes('host') ? <Link href="/host">Host console</Link> : null}
      </p>
      <SignOutButton />
    </main>
  );
}
