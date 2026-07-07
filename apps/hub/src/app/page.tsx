import Link from 'next/link';
import { signOut } from '../auth';
import { getBalance } from '../lib/participants';
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

  const balance = await getBalance(participant.email);
  return (
    <main>
      <h1>Krmx Hub</h1>
      <p>
        Signed in as {participant.email}
        {participant.roles.length > 0 ? ` (${participant.roles.join(', ')})` : ''}.
      </p>
      <p>Credits: {balance}</p>
      {participant.roles.includes('admin') ? (
        <p>
          <Link href="/admin">Admin dashboard</Link>
        </p>
      ) : null}
      <SignOutButton />
    </main>
  );
}
