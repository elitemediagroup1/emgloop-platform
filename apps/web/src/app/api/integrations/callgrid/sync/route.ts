import { NextResponse } from 'next/server';
import {
  prisma,
  repositories,
  CallGridPollService,
  pollSucceeded,
  sinceForRange,
  type SyncRange,
} from '@emgloop/database';
import { easternBusinessDayWindow, isBusinessDate } from '@emgloop/shared';
import { can } from '../../../../../auth/auth';
import { LIVE_ORG_SLUG, ensureLiveOrganization } from '../../../../../crm/live-org';

// CallGrid REST sync - Sprint 17 (admin-only), rebuilt on the canonical poll.
//
// POST /api/integrations/callgrid/sync  { range: "today" | "24h" | "7d" }
// POST /api/integrations/callgrid/sync  { date: "YYYY-MM-DD" }
// POST /api/integrations/callgrid/sync  { ..., dryRun: true }
//
// Pulls calls from the CallGrid REST API and brings the Loop in sync. Admin-only
// (integrations:manage). The API key is read from CALLGRID_API_KEY and never
// returned. Webhook ingestion and Bearer webhook auth are untouched by this route.
//
// WHAT CHANGED IN PR 9, AND WHY IT HAD TO. This route used to call
// `CallGridReconciliationService.reconcile`, which was a SECOND write-capable
// CallGrid REST path and an unsafe one. It ingested every record it had fetched
// and only afterwards reported that the read had truncated -- so a 6,918-call day
// that returned 2,500 records left 2,500 correct rows behind describing an
// interval that was not correct. And for a call Loop already held, it took its own
// short-cut: a direct `Interaction.metadata` merge that never reached
// IngestionService, so no observation was recorded, no provenance was written and
// no provider fact converged. Every re-observation through this button was
// invisible to PR #181 and unreachable by PR #182.
//
// It now calls `CallGridPollService.execute` -- the same primitive the manual
// operations runner calls, with the same completeness gate, the same fail-closed
// refusal policy and the same outcome vocabulary. There is one write-capable
// CallGrid REST path and this is a caller of it, not a variant of it.
//
// AN INCOMPLETE READ NOW WRITES NOTHING. Previously a truncated run returned 200
// with `ok: false` and the rows it had already imported stayed. Now truncation,
// an exhausted 429 budget, a pagination fault and a provider error all write
// ZERO rows, and the response says which. That is a deliberate behaviour change:
// a lower bound on an interval is evidence, not a sync.
//
// THE RANGE IS RESOLVED HERE, NOT THERE. `today` / `24h` / `7d` are convenience
// for a person looking at a button. They are resolved to explicit instants at
// this edge, because a primitive that can invent its own upper bound is one a
// scheduler can later ask for "the last seven days" without ever saying what it
// means.

export const dynamic = 'force-dynamic';

const VALID_RANGES: SyncRange[] = ['today', '24h', '7d'];

/**
 * A reporting DayWindow, as the poll's explicit interval.
 *
 * Two names for the same half-open pair: `business-time.ts` speaks start/end
 * because it describes a reporting period, and the poll speaks since/until
 * because it describes a fetch. Translated in one place rather than either
 * vocabulary bending to the other.
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
  let dryRun = false;
  try {
    const body = (await req.json()) as { range?: string; date?: string; dryRun?: boolean };
    if (body && typeof body.range === 'string' && (VALID_RANGES as string[]).includes(body.range)) {
      range = body.range as SyncRange;
    }
    if (body && body.dryRun === true) dryRun = true;
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

  // BOTH BOUNDS BECOME EXPLICIT BEFORE THE PRIMITIVE IS ENTERED. A named business
  // date is one complete Eastern day, derived from the one helper allowed to
  // decide where a day begins. A preset is resolved against this request's clock,
  // once, here.
  const now = new Date();
  const window = businessDate
    ? toExplicitWindow(easternBusinessDayWindow(businessDate))
    : { since: sinceForRange(range, now), until: now };

  const service = new CallGridPollService(prisma);

  try {
    const result = await service.execute({
      organizationId: org.id,
      apiKey,
      since: window.since,
      until: window.until,
      apiBaseUrl,
      providerConnectionId: connection.id,
      dryRun,
    });

    const at = new Date().toISOString();
    const diag = {
      at,
      range: businessDate ? 'explicit' : range,
      businessDate,
      since: result.since,
      until: result.until,
      dryRun: result.dryRun,
      outcome: result.outcome,
      fetched: result.providerRecordsFetched,
      accepted: result.acceptedRecords,
      refused: result.refusedRecords,
      imported: result.newEvents,
      reObserved: result.duplicateObservations,
      strengthened: result.strengthenedCalls,
      conflicts: result.conflicts,
      failed: result.failedProcessing,
      notAttempted: result.notAttempted,
      // Carried into the diagnostic so a later reader can tell a covered interval
      // from one that was never written, without re-running anything.
      pagesFetched: result.pages,
      pageCap: result.pageCap,
      fetchOutcome: result.fetchOutcome,
      apiKeyConfigured: true,
    };
    // A dry run must leave no trace that reads like a sync having happened.
    if (!dryRun) {
      try {
        await repositories.integrations.updateConnection(org.id, connection.id, {
          config: { ...connection.config, lastApiSync: diag },
          lastSyncedAt: new Date(),
        });
      } catch {
        // diagnostics are advisory; never fail the sync because of them
      }
    }

    // `ok` reflects the OUTCOME, not whether the request executed. A run that
    // wrote nothing because the read was short, and a run that stopped part-way
    // through writing, are both not-ok — and the outcome names which. Conflicts
    // are ok: the interval was polled, and two settled values disagreeing is a
    // question for a person rather than a failed request.
    return NextResponse.json({
      ok: pollSucceeded(result.outcome),
      outcome: result.outcome,
      result: {
        ...diag,
        reason: result.reason,
        // Page number and mapper reason only. No provider identity, no payload.
        refusals: result.refusals,
      },
    });
  } catch (err) {
    // Never let an exception escape as a non-JSON framework error page.
    const message = err instanceof Error ? err.message : 'sync-failed';
    return NextResponse.json(
      { ok: false, error: 'sync-failed', detail: message },
      { status: 500 },
    );
  }
}
