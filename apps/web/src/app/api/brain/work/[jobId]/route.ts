// One of this person's Brain jobs: its state, its named step, and where its results live.
// Slice B5. Another person's job, or another organization's, is not found.

import { NextResponse } from 'next/server';

import { getSession } from '../../../../../auth/auth';
import { brainWork } from '../../../../../brain/brain-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(_request: Request, { params }: { params: { jobId: string } }): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const work = ID.test(params.jobId)
    ? await brainWork().status({ organizationId: session.organizationId, userId: session.userId }, params.jobId)
    : null;
  if (!work) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true, work }, { headers: { 'cache-control': 'no-store' } });
}
