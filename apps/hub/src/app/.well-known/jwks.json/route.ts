import { NextResponse } from 'next/server';
import { getTicketKeys } from '../../../lib/keys';

// Must reflect the runtime signing key, never a build-time snapshot.
export const dynamic = 'force-dynamic';

/** Public ticket-verification keys (ARCHITECTURE §4). Verifiers cache this. */
export async function GET(): Promise<NextResponse> {
  const { publicJwk } = await getTicketKeys();
  return NextResponse.json(
    { keys: [publicJwk] },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
