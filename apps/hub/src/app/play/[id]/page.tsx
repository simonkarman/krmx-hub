import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthzError, requireApproved } from '../../../lib/authz';
import { getPlayableInstance, isInstancePlayer } from '../../../lib/instances';
import { currentParticipant } from '../../../lib/session';
import { PlayFrame } from './play-frame';

/**
 * Play page (ARCHITECTURE §6.3). Membership + approval are verified server-side
 * here (F-06) and again by the ticket endpoint the frame calls. The registered
 * frontend_url is the only origin ever framed (§9.1); the ticket is never in
 * this page's HTML or URL (§9.3, F-04) — the frame fetches it after handshake.
 */
export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let participant;
  try {
    participant = requireApproved(await currentParticipant());
  } catch (error) {
    if (error instanceof AuthzError) redirect(error.status === 401 ? '/signin' : '/');
    throw error;
  }

  const instance = await getPlayableInstance(id);
  if (!instance || !(await isInstancePlayer(id, participant.email))) {
    // Non-members learn nothing about the instance (F-06).
    redirect('/');
  }

  if (instance.status !== 'lobby' && instance.status !== 'running') {
    return (
      <main>
        <h1>Not playable</h1>
        <p>
          This instance is {instance.status}. <Link href="/">Home</Link>
        </p>
      </main>
    );
  }

  const registeredOrigin = new URL(instance.frontendUrl).origin;
  return (
    <main>
      <p>
        <Link href="/">← Hub</Link> · instance {id}
      </p>
      <PlayFrame frontendUrl={instance.frontendUrl} registeredOrigin={registeredOrigin} instanceId={id} />
    </main>
  );
}
