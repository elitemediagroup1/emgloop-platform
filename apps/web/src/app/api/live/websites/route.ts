import { NextResponse } from 'next/server';
import { crmRepos, resolveCrmOrganizationId } from '../../../../crm/crm-data';
import { can } from '../../../../auth/auth';

// Live Website Feed API — Sprint 15 (Live Operations).
//
// Read-only JSON endpoint polled by the Live Website page. Website interactions
// grouped into sessions (newest first) from the existing pipeline. Gated by the
// 'intelligence' resource. Deterministic; nothing fabricated.

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const allowed = await can('intelligence', 'view');
  if (!allowed) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const orgId = await resolveCrmOrganizationId();
  if (!orgId) {
    return NextResponse.json({ ok: true, sessions: [], orgReady: false });
  }

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(120, Math.floor(limitRaw)) : 60;

  const sessions = await crmRepos.liveOperations.listLiveWebsiteActivity(orgId, limit);
  return NextResponse.json({ ok: true, sessions, orgReady: true, at: new Date().toISOString() });
}
