import { readConnectionWorkerEndpoint } from '../../../../connections/connection-environment';
import { NextResponse } from 'next/server';
import { verifyWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
import { creatorMailService, creatorMailSharingEnabled, managedCreatorMailService } from '../../../../creator/creator-mail-runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const body = await request.text();
  const expected = readConnectionWorkerEndpoint()?.secret;
  if (body !== '{"purpose":"creator-brand-updates","version":1}' || !expected || !verifyWorkerRequest(expected, { body, signature: request.headers.get(WORKER_SIGNATURE_HEADER), timestamp: request.headers.get(WORKER_TIMESTAMP_HEADER), toleranceMs: 60_000 })) return NextResponse.json({ ok: false }, { status: 401 });
  if (!creatorMailSharingEnabled()) return NextResponse.json({ ok: true, enabled: false });
  try {
    const explicit = await creatorMailService().pass(1);
    if (Object.keys(explicit).length) return NextResponse.json({ ok: true, outcomes: explicit });
    const managed = await managedCreatorMailService().pass();
    // The deployed host understands PUBLISHED but not capture-phase counters. Zero is an honest
    // keep-going marker for metadata-only pages; no model output/publication is claimed by it.
    return NextResponse.json({ ok: true, outcomes: Object.keys(managed).length ? { PUBLISHED: 0, ...managed } : {} });
  }
  catch { return NextResponse.json({ ok: false, failure: 'PASS_FAILED' }, { status: 503 }); }
}
