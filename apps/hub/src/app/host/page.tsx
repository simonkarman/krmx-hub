import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthzError, requireHost } from '../../lib/authz';
import { listGamesByHost, listVersions } from '../../lib/games';
import { currentParticipant } from '../../lib/session';
import { HostConsole } from './host-console';

export default async function HostPage() {
  let host;
  try {
    host = requireHost(await currentParticipant());
  } catch (error) {
    if (error instanceof AuthzError) redirect(error.status === 401 ? '/signin' : '/');
    throw error;
  }

  const games = await listGamesByHost(host.email);
  const versionsByGame = Object.fromEntries(
    await Promise.all(games.map(async (g) => [g.id, await listVersions(g.id)] as const)),
  );

  return (
    <main>
      <h1>Host console</h1>
      <p>
        <Link href="/">Home</Link>
      </p>
      <h2>Your games</h2>
      {games.length === 0 ? <p>No games yet.</p> : null}
      {games.map((game) => (
        <section key={game.id} style={{ border: '1px solid #ccc', padding: 8, marginBottom: 8 }}>
          <strong>
            {game.name} ({game.id})
          </strong>{' '}
          — {game.status}, entry fee {game.entryFee}
          <ul>
            {(versionsByGame[game.id] ?? []).map((v) => (
              <li key={v.id}>
                v{v.semver} [{v.status}] — frontend {v.frontendUrl}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <HostConsole />
    </main>
  );
}
