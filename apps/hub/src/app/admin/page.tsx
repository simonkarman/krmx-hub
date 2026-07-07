import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthzError, requireAdmin } from '../../lib/authz';
import { listParticipants } from '../../lib/participants';
import { currentParticipant } from '../../lib/session';
import { ParticipantActions } from './participant-actions';

export default async function AdminPage() {
  // Re-checked here, and again inside every API route the buttons call (§9.9).
  try {
    requireAdmin(await currentParticipant());
  } catch (error) {
    if (error instanceof AuthzError) redirect(error.status === 401 ? '/signin' : '/');
    throw error;
  }

  const participants = await listParticipants();
  return (
    <main>
      <h1>Admin dashboard</h1>
      <p>
        <Link href="/">Home</Link>
      </p>
      <table border={1} cellPadding={6}>
        <thead>
          <tr>
            <th>Email</th>
            <th>Status</th>
            <th>Roles</th>
            <th>Credits</th>
            <th>Requested</th>
            <th>Decided by</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {participants.map((p) => (
            <tr key={p.email}>
              <td>{p.email}</td>
              <td>{p.status}</td>
              <td>{p.roles.join(', ') || '—'}</td>
              <td>{p.balance}</td>
              <td>{p.requestedAt.toISOString()}</td>
              <td>{p.decidedBy ?? '—'}</td>
              <td>
                <ParticipantActions email={p.email} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
