// Internal Brain API: hand a candidate result to its owning authority. Slice B5.
//
// For an authenticated execution-environment worker only. The body -- bound to the token
// by its SHA-256 -- names the step and carries the result envelope. What the result must
// be comes from the job alone; the evidence it may cite is re-assembled now; the owner's
// gate decides and stores. Brain never stores a result itself.

import { NextResponse } from 'next/server';
import { isBrainStepKey, type BrainResultEnvelope } from '@emgloop/shared';

import { brainInternal, loadBrainJobForWorker } from '../../../../../brain/brain-runtime';
import { authenticateBrainWorkerRequest } from '../../../../../brain/worker-request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function commitBody(body: unknown): { stepKey: string; envelope: BrainResultEnvelope } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== 'stepKey' && k !== 'envelope')) return null;
  if (typeof b.stepKey !== 'string' || !isBrainStepKey(b.stepKey)) return null;
  const e = b.envelope as Record<string, unknown> | null;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  if (!Array.isArray(e.claims) || !Array.isArray(e.evidenceRefs) || !Array.isArray(e.limitations)) return null;
  if (!e.provenance || typeof e.provenance !== 'object' || !e.owner || typeof e.owner !== 'object' || !e.subject || typeof e.subject !== 'object') return null;
  return { stepKey: b.stepKey, envelope: e as unknown as BrainResultEnvelope };
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateBrainWorkerRequest(request, 'COMMIT_RESULT', { loadJob: loadBrainJobForWorker });
  if (!auth.ok) return NextResponse.json({ ok: false, refusals: auth.refusals }, { status: auth.status });
  const parsed = commitBody(auth.body);
  if (!parsed) return NextResponse.json({ ok: false, refusals: ['MALFORMED_BODY'] }, { status: 400 });
  const answer = await brainInternal().commit(auth.job, parsed.stepKey, parsed.envelope);
  if (!answer.ok) {
    return NextResponse.json({ ok: false, refusals: [answer.refusal, ...answer.details] }, { status: answer.refusal === 'NOT_PERMITTED' ? 403 : 409 });
  }
  return NextResponse.json({ ok: true, ref: answer.ref, commitKey: answer.commitKey }, { headers: { 'cache-control': 'no-store' } });
}
