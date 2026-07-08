import Link from 'next/link';
import { signOut } from '../auth';
import { listPublishedGames } from '../lib/games';
import { listInstancesForPlayer } from '../lib/instances';
import { getBalance, listLedger } from '../lib/participants';
import { currentParticipant } from '../lib/session';
import { CreateInstanceButton, JoinByIdForm } from './lobby-actions';

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

  const [balance, ledger, games, myInstances] = await Promise.all([
    getBalance(participant.email),
    listLedger(participant.email),
    listPublishedGames(),
    listInstancesForPlayer(participant.email),
  ]);
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

      <h2>Play</h2>
      {games.length === 0 ? <p>No published games yet.</p> : null}
      <ul>
        {games.map((game) => (
          <li key={game.id}>
            {game.name} (entry fee {game.entryFee}) <CreateInstanceButton gameId={game.id} />
          </li>
        ))}
      </ul>
      {myInstances.length > 0 ? (
        <>
          <h3>Your instances</h3>
          <ul>
            {myInstances.map((inst) => (
              <li key={inst.id}>
                {inst.gameName} — {inst.status}{' '}
                {inst.status === 'lobby' || inst.status === 'running' ? (
                  <Link href={`/play/${inst.id}`}>Play</Link>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <details>
        <summary>Join by instance id</summary>
        <JoinByIdForm />
      </details>

      <h2>Credit activity</h2>
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
