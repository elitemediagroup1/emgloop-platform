import { NextResponse } from 'next/server';
import { crmRepos } from '../../../crm/crm-data';
import { can, getSession } from '../../../auth/auth';

// Traffic Intelligence API — Sprint 15 (Traffic Intelligence).
//
// Read-only JSON endpoint backing the Traffic dashboard: vendors, sources,
// campaigns and buyers with calls / qualified % / bookings / revenue /
// conversion, plus deterministic Brain insights. Attribution derives from
// Interaction.metadata written by the NormalizationEngine. Gated by the
// 'analytics' resource. No external ad/analytics APIs.

export const dynamic = 'force-dynamic';

export async function GET() {
  const allowed = await can('analytics', 'view');
  if (!allowed) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const orgId = session.organizationId;
  if (!orgId) {
    return NextResponse.json({ ok: true, traffic: null, orgReady: false });
  }

  const traffic = await crmRepos.revenueIntelligence.trafficIntelligence(orgId);
  // See the note in api/revenue/route.ts — capped scans must never read as complete.
  return NextResponse.json({
    ok: true,
    traffic,
    partial: !traffic.coverage.complete,
    orgReady: true,
    at: new Date().toISOString(),
  });
}
