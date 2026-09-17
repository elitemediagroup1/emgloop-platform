// This person's Brain work, read from Loop's records. Slice B5.
//
// A page that was closed, reloaded or opened on another device asks here what is
// running, what is waiting and what finished. The answer never depends on the browser
// that submitted the work. The organization and the person are the signed session's.

import { NextResponse } from 'next/server';

import { getSession } from '../../../../auth/auth';
import { brainWork } from '../../../../brain/brain-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const principal = { organizationId: session.organizationId, userId: session.userId };
  const service = brainWork();
  const [work, working] = await Promise.all([service.listMine(principal), service.workingCount(principal)]);
  return NextResponse.json({ ok: true, working, work }, { headers: { 'cache-control': 'no-store' } });
}
