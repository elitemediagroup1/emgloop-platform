import { NextResponse } from 'next/server';
import { crmRepos, resolveCrmOrganizationId } from '../../../../crm/crm-data';
import { can } from '../../../../auth/auth';

// Live Call Feed API — Sprint 15 (Live Operations).
//
// Read-only JSON endpoint polled by the Live Calls page. Every PHONE
// interaction, attribution-enriched (vendor / source / campaign / caller /
// duration / qualified / next best action) from Interaction.metadata. Gated by
// the 'intelligence' resource. Deterministic; nothing fabricated.

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const allowed = await can('intelligence', 'view');
  if (!allowed) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const orgId = await resolveCrmOrganizationId();
  if (!orgId) {
    return NextResponse.json({ ok: true, calls: [], orgReady: false });
  }

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 50;

  const calls = await crmRepos.liveOperations.listLiveCalls(orgId, limit);
  return NextResponse.json({ ok: true, calls, orgReady: true, at: new Date().toISOString() });
}
