import type { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/authz';
import { errorResponse, json } from '../../../../lib/http';
import { listParticipants } from '../../../../lib/participants';
import { currentParticipant } from '../../../../lib/session';

export async function GET(): Promise<NextResponse> {
  try {
    requireAdmin(await currentParticipant());
    return json({ participants: await listParticipants() });
  } catch (error) {
    return errorResponse(error);
  }
}
