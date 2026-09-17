// The question a Brain job is waiting on, for the one person who may answer it. Slice B5.
// Anyone else -- another member, another organization -- is told it does not exist.

import { NextResponse } from 'next/server';

import { getSession } from '../../../../../auth/auth';
import { brainWork } from '../../../../../brain/brain-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(_request: Request, { params }: { params: { waitId: string } }): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const question = ID.test(params.waitId)
    ? await brainWork().question({ organizationId: session.organizationId, userId: session.userId }, params.waitId)
    : null;
  if (!question) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true, question }, { headers: { 'cache-control': 'no-store' } });
}
