import { readConnectionWorkerEndpoint } from '../../../../connections/connection-environment';
import { NextResponse } from 'next/server';
import { verifyWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
import { creatorMailService, creatorMailSharingEnabled, managedCreatorMailService, managedCreatorMailRepository, creatorRelationshipService } from '../../../../creator/creator-mail-runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const body = await request.text();
  const expected = readConnectionWorkerEndpoint()?.secret;
  if (body !== '{"purpose":"creator-brand-updates","version":1}' || !expected || !verifyWorkerRequest(expected, { body, signature: request.headers.get(WORKER_SIGNATURE_HEADER), timestamp: request.headers.get(WORKER_TIMESTAMP_HEADER), toleranceMs: 60_000 })) return NextResponse.json({ ok: false }, { status: 401 });
  if (!creatorMailSharingEnabled()) return NextResponse.json({ ok: true, enabled: false });
  try {
    if (!await managedCreatorMailRepository().ready()) return NextResponse.json({ ok: true, enabled: false, reason: 'MIGRATION_REQUIRED' });
    await managedCreatorMailRepository().resumeAfterBudgetChange(new Date());
    await managedCreatorMailRepository().morningRefresh(new Date());
    // Alternate capture and relationship work so neither can starve the other.
    const synthesisTurn = Math.floor(Date.now() / 60_000) % 2 === 0;
    if (synthesisTurn) {
      const synthesis = await creatorRelationshipService().pass();
      if (Object.keys(synthesis).length) return NextResponse.json({ ok: true, outcomes: { PUBLISHED: 0, ...synthesis } });
    }
    const explicit = await creatorMailService().pass(1);
    if (Object.keys(explicit).length) return NextResponse.json({ ok: true, outcomes: explicit });
    const managed = await managedCreatorMailService().pass();
    // The deployed host understands PUBLISHED but not capture-phase counters. Zero is an honest
    // keep-going marker for metadata-only pages; no model output/publication is claimed by it.
    const outcomes = Object.keys(managed).length ? managed : await creatorRelationshipService().pass();
    return NextResponse.json({ ok: true, outcomes: Object.keys(outcomes).length ? { PUBLISHED: 0, ...outcomes } : {} });
  }
  catch { return NextResponse.json({ ok: false, failure: 'PASS_FAILED' }, { status: 503 }); }
}
