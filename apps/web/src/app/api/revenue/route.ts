import { NextResponse } from 'next/server';
import { serializeTruth, hasValue, isPartial } from '@emgloop/shared';
import { crmRepos } from '../../../crm/crm-data';
import { can, getSession } from '../../../auth/auth';

// Revenue Intelligence API — Sprint 15 (Revenue Intelligence).
//
// Read-only JSON endpoint backing the Revenue dashboard. Deterministic revenue
// attribution by website / vendor / source / campaign / buyer / channel /
// signal / journey, realized from Orders already persisted in Neon (no Stripe,
// no AI, no accounting integrations). Gated by the 'analytics' resource.

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
    return NextResponse.json({ ok: true, revenue: null, orgReady: false });
  }

  const revenue = await crmRepos.revenueIntelligence.revenueByDimension(orgId);
  // `partial` is hoisted to the top level so a consumer cannot read the totals
  // without also seeing that the underlying scan was capped. See CAPS in
  // revenue-intelligence.repository.ts — this stays until SQL aggregation ships.
  // Serialized as Truth, so a client receives the state and its provenance
  // rather than a bare number it would have to interpret for itself.
  // `partial` stays hoisted for consumers that already read it.
  return NextResponse.json({
    ok: true,
    revenue: hasValue(revenue) ? revenue.value : null,
    truth: serializeTruth(revenue),
    state: revenue.state,
    partial: isPartial(revenue),
    orgReady: true,
    at: new Date().toISOString(),
  });
}
