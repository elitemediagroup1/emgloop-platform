import { NextResponse } from 'next/server';
import { crmRepos } from '../../../../crm/crm-data';
import { can, getSession } from '../../../../auth/auth';

// Live Website Feed API — Sprint 15 (Live Operations), real-data hotfix.
//
// Read-only JSON endpoint polled by the Live Website page. Recent website
// interactions grouped into sessions (newest first), demo/QA/test records
// excluded. Optional ?property=<key> filters to a single EMG property. Gated
// by the 'intelligence' resource. Deterministic; nothing fabricated.

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const allowed = await can('intelligence', 'view');
  if (!allowed) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const orgId = session.organizationId;
  if (!orgId) {
    return NextResponse.json({ ok: true, sessions: [], orgReady: false });
  }

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(120, Math.floor(limitRaw)) : 60;
  const property = url.searchParams.get('property');

  const sessions = await crmRepos.liveOperations.listLiveWebsiteActivity(orgId, limit, property);
  return NextResponse.json({ ok: true, sessions, orgReady: true, property: property ?? null, at: new Date().toISOString() });
}
