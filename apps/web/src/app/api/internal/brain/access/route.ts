// Internal Brain API: may this job's principal still do this work, right now? Slice B5.
//
// For an authenticated execution-environment worker only (worker-request.ts). No session,
// no cookie, no organization in the request: the job the token names is the authority,
// and the answer is decided from Loop's membership and permission records at this moment.

import { NextResponse } from 'next/server';

import { brainInternal, loadBrainJobForWorker } from '../../../../../brain/brain-runtime';
import { authenticateBrainWorkerRequest } from '../../../../../brain/worker-request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateBrainWorkerRequest(request, 'ACCESS_DECISION', { loadJob: loadBrainJobForWorker });
  if (!auth.ok) return NextResponse.json({ ok: false, refusals: auth.refusals }, { status: auth.status });
  const answer = await brainInternal().access(auth.job);
  return NextResponse.json({ ok: true, ...answer }, { headers: { 'cache-control': 'no-store' } });
}
