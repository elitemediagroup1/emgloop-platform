import { NextResponse } from 'next/server';
import { crmRepos } from '../../../../crm/crm-data';
import { can, getSession } from '../../../../auth/auth';

// Live Activity Feed API — Sprint 15 (Live Operations).
//
// Read-only, deterministic JSON endpoint polled by the Live Operations page
// every 5-10s (no websockets). Permission-gated by the 'intelligence' resource,
// the same key used by the Live Operations surface. All data flows from the
// existing pipeline via LiveOperationsRepository; nothing is fabricated.

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
    return NextResponse.json({ ok: true, items: [], orgReady: false });
  }

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 40;

  const items = await crmRepos.liveOperations.listLiveActivity(orgId, limit);
  return NextResponse.json({ ok: true, items, orgReady: true, at: new Date().toISOString() });
}
