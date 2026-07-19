import { NextResponse } from 'next/server';
import { crmRepos, requireCrmContext } from '../../../../../crm/crm-data';
import { can } from '../../../../../auth/auth';

// MarketplaceCall backfill — explicit, bounded, admin-only.
//
// WHY THIS EXISTS
//
// Live reconciliation proved the read model was empty: 108 calls at CallGrid,
// 0 rows in Loop. The cause was that ingestion never projected — the only
// population path was a lazy backfill triggered by loading the Brain admin
// page, scoped to that page's own 7-day window, and only when that window was
// already empty.
//
// Ingestion now projects write-through, which fixes every call from here on.
// It does NOT retrofit calls already ingested. This route does that, for a
// bounded window, as an EXPLICIT operator action — never automatically, and
// never as a side effect of rendering a page. Backfilling silently from a read
// path is what hid the gap for this long.
//
// SAFETY
//   • POST, because it writes. Deliberately not folded into the read-only
//     reconciliation route, which must stay incapable of altering what it audits.
//   • Admin-gated on integrations:manage.
//   • Organization from the SIGNED SESSION, never a parameter.
//   • Idempotent: projectWindow upserts on (provider, externalId), so running it
//     twice produces the same rows. Safe to retry.
//   • Bounded to one UTC day per call.
//   • Reads Interaction and writes only MarketplaceCall. It cannot modify the
//     source data — MarketplaceCall is a rebuildable projection over Interaction.
//   • Returns counts only: no phone numbers, no payloads, no identifiers.

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!(await can('integrations', 'manage'))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const { organizationId } = await requireCrmContext();
  if (!organizationId) {
    return NextResponse.json({ ok: false, error: 'no-organization' }, { status: 400 });
  }

  // One complete UTC day, matching the window reconciliation compares over.
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  const day =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? new Date(`${dateParam}T00:00:00.000Z`)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(day.getTime())) {
    return NextResponse.json({ ok: false, error: 'invalid-date' }, { status: 400 });
  }
  const since = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const until = new Date(since.getTime() + 24 * 60 * 60 * 1000);

  try {
    const result = await crmRepos.marketplaceCalls.projectWindow(organizationId, since, until);
    const projectedNow = await crmRepos.marketplaceCalls.countWindow(organizationId, since, until);

    return NextResponse.json({
      ok: true,
      window: { since: since.toISOString(), until: until.toISOString(), day: since.toISOString().slice(0, 10) },
      // `scanned` counts PHONE Interactions in the window; `skipped` counts rows
      // the pure mapper declined — no provider/externalId, or an excluded
      // demo/test customer. A high skip count is a mapping signal, not a failure.
      interactionsScanned: result.scanned,
      projected: result.projected,
      skipped: result.skipped,
      marketplaceCallsInWindow: projectedNow,
      at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: 'backfill-failed',
        detail: error instanceof Error ? error.message : 'unknown',
      },
      { status: 500 },
    );
  }
}
