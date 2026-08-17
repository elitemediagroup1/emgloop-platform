import { NextResponse } from 'next/server';
import {
  prisma,
  repositories,
  CallGridReconciliationService,
  type SyncRange,
} from '@emgloop/database';
import { easternBusinessDayWindow, isBusinessDate } from '@emgloop/shared';
import { can } from '../../../../../auth/auth';
import { LIVE_ORG_SLUG, ensureLiveOrganization } from '../../../../../crm/live-org';

// CallGrid reconciliation sync - Sprint 17 (admin-only).
//
// POST /api/integrations/callgrid/sync  { range: "today" | "24h" | "7d" }
// POST /api/integrations/callgrid/sync  { date: "YYYY-MM-DD" }
//
// Pulls recent calls from the CallGrid REST API (source of truth) and brings
// the Loop in sync: imports calls the webhook missed and enriches calls that
// arrived without full attribution. Admin-only (integrations:manage). The API
// key is read from CALLGRID_API_KEY and never returned. Webhook ingestion and
// Bearer webhook auth are untouched by this route.
//
// `date` BOUNDS THE RUN TO ONE COMPLETE EASTERN BUSINESS DAY. Every preset is
// resolved against the clock with an implicit upper bound of now, so before this
// existed there was no way to ask for a single past day: the nearest option was
// `7d`, which on a busy week is several times the page budget and therefore
// truncates. The window is derived from `business-time.ts` rather than computed
// here, so a sync and a measurement can never disagree about where a day begins.
//
// A TRUNCATED RUN IS NOT A SUCCESSFUL RUN. When the provider still had pages and
// the adapter stopped at its budget, this returns 200 with `ok: false` and
// `truncated: true`: the rows it imported are real and were written, so the call
// did not fail, but the window was not covered and no caller may record it as
// complete. Reporting a budgeted stop as a clean finish is exactly how a
// 6,918-call day was read as 2,500.

export const dynamic = 'force-dynamic';

const VALID_RANGES: SyncRange[] = ['today', '24h', '7d'];

/**
 * A reporting DayWindow, as the reconciliation's explicit interval.
 *
 * Two names for the same half-open pair: `business-time.ts` speaks start/end
 * because it describes a reporting period, and the reconciliation speaks
 * since/until because it describes a fetch. Translated in one place rather than
 * either vocabulary bending to the other.
 */
function toExplicitWindow(window: { start: Date; end: Date }): { since: Date; until: Date } {
  return { since: window.start, until: window.end };
}

export async function POST(req: Request) {
  const allowed = await can('integrations', 'manage');
  if (!allowed) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  let range: SyncRange = '24h';
  let businessDate: string | null = null;
  try {
    const body = (await req.json()) as { range?: string; date?: string };
    if (body && typeof body.range === 'string' && (VALID_RANGES as string[]).includes(body.range)) {
      range = body.range as SyncRange;
    }
    if (body && typeof body.date === 'string' && body.date.trim() !== '') {
      if (!isBusinessDate(body.date.trim())) {
        return NextResponse.json(
          { ok: false, error: 'invalid-date', hint: 'Pass date as YYYY-MM-DD (one Eastern business day).' },
          { status: 400 },
        );
      }
      businessDate = body.date.trim();
    }
  } catch {
    // empty/invalid body -> default range
  }

  const apiKey = process.env.CALLGRID_API_KEY || '';
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'api-key-not-configured', hint: 'Set CALLGRID_API_KEY in Netlify.' },
      { status: 400 },
    );
  }

  await ensureLiveOrganization();
  const org = await prisma.organization.findUnique({
    where: { slug: LIVE_ORG_SLUG },
    select: { id: true },
  });
  if (!org) {
    return NextResponse.json({ ok: false, error: 'organization-not-found' }, { status: 404 });
  }
  let connection = (await repositories.integrations.listConnections(org.id)).find(
    (c) => c.provider === 'callgrid' && c.category === 'ingestion',
  );
  if (!connection) {
    connection = await repositories.integrations.createConnection({
      organizationId: org.id,
      category: 'ingestion',
      provider: 'callgrid',
      displayName: 'CallGrid',
      config: { allowUnsigned: false },
    });
  }

  const apiBaseUrl =
    typeof connection.config?.['apiBaseUrl'] === 'string'
      ? (connection.config['apiBaseUrl'] as string)
      : undefined;
  const service = new CallGridReconciliationService(prisma);

  try {
    const result = await service.reconcile({
    organizationId: org.id,
    apiKey,
    range,
    // One complete Eastern business day when a date was named, derived from the
    // one helper allowed to decide what a day is.
    window: businessDate ? toExplicitWindow(easternBusinessDayWindow(businessDate)) : undefined,
    apiBaseUrl,
    providerConnectionId: connection.id,
  });

  const diag = {
    at: result.at,
    range: result.range,
    businessDate,
    since: result.since,
    until: result.until,
    fetched: result.fetched,
    imported: result.imported,
    enriched: result.enriched,
    skippedDuplicate: result.skippedDuplicate,
    failed: result.failed,
    errorCount: result.errors.length,
    // Carried into the diagnostic so a later reader can tell a covered window
    // from a partial one without re-running anything.
    pagesFetched: result.pagesFetched,
    pageCap: result.pageCap,
    truncated: result.truncated,
    apiKeyConfigured: true,
  };
  try {
    await repositories.integrations.updateConnection(org.id, connection.id, {
      config: { ...connection.config, lastApiSync: diag },
      lastSyncedAt: new Date(),
    });
  } catch {
    // diagnostics are advisory; never fail the sync because of them
  }

    // `ok` reflects COVERAGE, not whether the request executed. A truncated run
    // imported real rows and is not an error, but it did not cover the window and
    // must never be reported as though it had.
    return NextResponse.json({ ok: !result.truncated, truncated: result.truncated, result });
  } catch (err) {
    // Never let an exception escape as a non-JSON framework error page.
    const message = err instanceof Error ? err.message : 'sync-failed';
    return NextResponse.json(
      { ok: false, error: 'sync-failed', detail: message },
      { status: 500 },
    );
  }
}
