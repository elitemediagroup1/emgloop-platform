// Internal Brain API: the minimized, authorized context for this job's task. Slice B5.
//
// For an authenticated execution-environment worker only. The context is assembled now,
// under a fresh access decision for the job's principal, and contains only what the task
// may see; everything withheld is reported as a count. Nothing the worker sends selects
// what is read.

import { NextResponse } from 'next/server';

import { brainInternal, loadBrainJobForWorker } from '../../../../../brain/brain-runtime';
import { authenticateBrainWorkerRequest } from '../../../../../brain/worker-request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateBrainWorkerRequest(request, 'CONTEXT', { loadJob: loadBrainJobForWorker });
  if (!auth.ok) return NextResponse.json({ ok: false, refusals: auth.refusals }, { status: auth.status });
  const answer = await brainInternal().context(auth.job);
  if (!answer.ok) return NextResponse.json({ ok: false, refusals: [answer.refusal] }, { status: answer.refusal === 'NOT_PERMITTED' ? 403 : 409 });
  return NextResponse.json(
    { ok: true, context: answer.context, decision: answer.access.decision, principal: answer.access.principal, commitGate: answer.commitGate },
    { headers: { 'cache-control': 'no-store' } },
  );
}
