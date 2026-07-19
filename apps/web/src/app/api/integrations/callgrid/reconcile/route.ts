import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { crmRepos, requireCrmContext } from '../../../../../crm/crm-data';
import { can } from '../../../../../auth/auth';
import { fetchCallGridCallsPage, pickField, toNumber } from '@emgloop/providers';
import {
  reconcile,
  type CallGridSourceCall,
  type LoopCall,
} from '@emgloop/database';

// CallGrid live reconciliation — READ-ONLY, admin-only, one bounded day.
//
// WHY THIS EXISTS
//
// The forensic audit could verify structure but never values, because no
// CallGrid record had ever been compared against Loop. This route is the one
// missing piece: it pulls a bounded day from the CallGrid API using the
// server-side credential, reads Loop's MarketplaceCall rows for the SAME
// window, and returns a redacted comparison.
//
// Its primary job is to settle the money unit. `centsOrNull` multiplies by 100
// on the assumption that CallGrid states decimal dollars. If that assumption is
// wrong, every revenue figure in the platform is 100x too large and looks
// entirely plausible. This route reports raw-vs-projected for a few records so
// the question is answered by evidence rather than inference.
//
// SECURITY POSTURE — every one of these is deliberate:
//   • GET only. It performs NO writes: no ingestion, no projection, no
//     ensureLiveOrganization(). It cannot alter the data it is auditing.
//   • Admin-gated on integrations:manage, same as the sync route.
//   • Organization comes from the SIGNED SESSION, never a query param.
//     CLAUDE.md forbids a fourth route resolving org from LIVE_ORG_SLUG.
//   • The API key is read from the environment and NEVER returned, logged or
//     echoed — not even a prefix or a length.
//   • No caller phone numbers, no transcripts, no raw payload bodies leave
//     this route. Provider record ids are returned only as a short hash, so a
//     mismatch stays traceable without exposing the identifier.
//   • Bounded: one calendar day, and a hard page cap.
//
// Remove this route, or leave it disabled, once reconciliation is complete.

export const dynamic = 'force-dynamic';

/** Hard ceiling so a wide day cannot pull an unbounded number of pages. */
const MAX_RECORDS = 500;
/** Records requested per page. */
const PAGE_SIZE = 100;
/** Belt-and-braces page ceiling, so a provider that always reports hasMore terminates. */
const MAX_PAGES = 10;

/** Short, stable, non-reversible handle for a provider record id. */
const handle = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 10);

export async function GET(req: Request) {
  if (!(await can('integrations', 'manage'))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  // Organization from the signed session only.
  const { organizationId } = await requireCrmContext();
  if (!organizationId) {
    return NextResponse.json({ ok: false, error: 'no-organization' }, { status: 400 });
  }

  const apiKey = process.env.CALLGRID_API_KEY || '';
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'api-key-not-configured', hint: 'CALLGRID_API_KEY is not present in this deploy context.' },
      { status: 400 },
    );
  }

  // One complete UTC day. Defaults to yesterday, which is the most recent day
  // that cannot still be receiving late deliveries.
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  const day = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
    ? new Date(`${dateParam}T00:00:00.000Z`)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(day.getTime())) {
    return NextResponse.json({ ok: false, error: 'invalid-date' }, { status: 400 });
  }
  const since = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const until = new Date(since.getTime() + 24 * 60 * 60 * 1000);

  // Money unit is DECLARED per run, never guessed. `dollars` matches what
  // centsOrNull currently assumes; the response reports whether the evidence
  // actually supports it.
  const unitParam = url.searchParams.get('unit');
  const sourceMoneyUnit = unitParam === 'cents' ? 'cents' : 'dollars';

  // Paginate over RAW records.
  //
  // The first version called fetchAllCallGridCalls, which returns
  // `{ events, pages, records }` — an OBJECT — and cast it to an array with
  // `as unknown as Array<...>`. That double cast defeated the type checker, and
  // the object reached `.slice()` at runtime: "t.slice is not a function".
  // TypeScript would have rejected it without the cast, so the cast WAS the bug.
  //
  // fetchCallGridCallsPage is also the correct function for this route:
  // fetchAllCallGridCalls returns InboundEvents already mapped through the
  // adapter, but reconciliation must compare against what CallGrid actually
  // sent, before Loop's own interpretation of it.
  const raw: Array<Record<string, unknown>> = [];
  try {
    let cursor: unknown = undefined;
    let pages = 0;
    while (raw.length < MAX_RECORDS && pages < MAX_PAGES) {
      const page = await fetchCallGridCallsPage({
        apiKey,
        since,
        until,
        limit: Math.min(PAGE_SIZE, MAX_RECORDS - raw.length),
        cursor,
      });
      pages += 1;
      raw.push(...page.records);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
  } catch (error) {
    // The message may name a host or status; it must never carry the key.
    return NextResponse.json(
      {
        ok: false,
        error: 'callgrid-request-failed',
        detail: error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') : 'unknown',
      },
      { status: 502 },
    );
  }

  // Project the provider records onto the harness's source shape. Field names
  // are the ones the confirmed webhook template uses.
  const source: CallGridSourceCall[] = raw.slice(0, MAX_RECORDS).map((r) => ({
    call_id: pickField(r, ['id', 'CallId', 'Id', 'call_id', 'callId']) ?? '',
    started_at: pickField(r, ['createdAt', 'CallDateTime', 'StartTime', 'started_at', 'occurredAtUnix']) ?? '',
    duration_seconds: toNumber(pickField(r, ['callDuration', 'Duration', 'duration', 'durationSeconds'])) ?? null,
    revenue: toNumber(pickField(r, ['revenue', 'Revenue'])) ?? null,
    payout: toNumber(pickField(r, ['payout', 'Payout'])) ?? null,
    cost: toNumber(pickField(r, ['cost', 'Cost'])) ?? null,
    profit: toNumber(pickField(r, ['profit', 'Profit', 'net_profit'])) ?? null,
    buyer: pickField(r, ['buyerName', 'BuyerName', 'buyer']) ?? null,
    campaign: pickField(r, ['campaignName', 'CampaignName', 'campaign']) ?? null,
    source: pickField(r, ['sourceName', 'SourceName', 'source']) ?? null,
    qualified: null,
    converted: null,
    duplicate: null,
  }));

  // Loop's side of the comparison, from the canonical read model only.
  const loopRows = await crmRepos.marketplaceCalls.listWindowForReconciliation(
    organizationId,
    since,
    until,
    MAX_RECORDS,
  );
  const loop: LoopCall[] = loopRows.map((c) => ({
    externalId: c.externalId,
    sourceOccurredAt: c.sourceOccurredAt,
    durationSeconds: c.durationSeconds,
    revenueCents: c.revenueCents,
    payoutCents: c.payoutCents,
    costCents: c.costCents,
    buyerLabel: c.buyerLabel,
    campaignLabel: c.campaignLabel,
    sourceLabel: c.sourceLabel,
    qualified: c.qualified,
    converted: c.converted,
    duplicate: c.duplicate,
  }));

  // Pipeline diagnostics: where records exist along the chain. This is what
  // turns "Loop shows 0" into "the projection stopped HERE".
  const phoneInteractions = await crmRepos.interactions.countPhoneInWindow(
    organizationId,
    since,
    until,
  );

  const report = reconcile(source, loop, { since, until, sourceMoneyUnit });

  // --- Money-unit evidence -------------------------------------------------
  // Raw source values beside what Loop persisted. Amounts are not PII. This is
  // the panel that settles dollars-vs-cents: if raw 25.50 became 2550 cents the
  // dollars assumption holds; if it became 25 cents, it does not.
  const loopById = new Map(loop.map((l) => [l.externalId, l]));
  const moneyEvidence = source
    .filter((s) => typeof s.revenue === 'number' && loopById.has(s.call_id))
    .slice(0, 5)
    .map((s) => {
      const l = loopById.get(s.call_id)!;
      const statedProfit = s.profit ?? null;
      const derived =
        typeof s.revenue === 'number' ? s.revenue - (s.payout ?? 0) - (s.cost ?? 0) : null;
      return {
        record: handle(s.call_id),
        sourceRevenue: s.revenue,
        sourcePayout: s.payout,
        sourceCost: s.cost,
        sourceProfit: statedProfit,
        loopRevenueCents: l.revenueCents,
        loopPayoutCents: l.payoutCents,
        loopCostCents: l.costCents,
        // If this ratio is 100 the source is dollars; if 1, the source is
        // already minor units and centsOrNull is inflating by 100x.
        revenueRatioLoopOverSource:
          typeof s.revenue === 'number' && s.revenue !== 0 && l.revenueCents !== null
            ? Number((l.revenueCents / s.revenue).toFixed(4))
            : null,
        profitInvariantHolds:
          statedProfit === null || derived === null ? null : Math.abs(derived - statedProfit) < 0.011,
      };
    });

  const ratios = moneyEvidence
    .map((m) => m.revenueRatioLoopOverSource)
    .filter((r): r is number => r !== null);
  const moneyUnitVerdict =
    ratios.length === 0
      ? 'indeterminate: no record carried both a source revenue and a projected value'
      : ratios.every((r) => Math.abs(r - 100) < 0.5)
        ? 'PROVEN dollars: Loop cents == source x 100 on every sampled record'
        : ratios.every((r) => Math.abs(r - 1) < 0.01)
          ? 'PROVEN cents: source is ALREADY minor units — centsOrNull is inflating by 100x'
          : `INCONSISTENT: ratios ${ratios.join(', ')} — investigate before trusting any revenue figure`;

  return NextResponse.json({
    ok: true,
    window: { since: since.toISOString(), until: until.toISOString(), day: since.toISOString().slice(0, 10) },
    declaredSourceMoneyUnit: sourceMoneyUnit,
    counts: {
      sourceRecords: report.sourceRecords,
      loopRecords: report.loopRecords,
      rawRecordsFetched: raw.length,
      capped: raw.length >= MAX_RECORDS,
      // CallGrid -> Interaction -> MarketplaceCall, at a glance. If
      // phoneInteractions is high and loopRecords is 0, ingestion works and the
      // PROJECTION is the gap. If both are 0, ingestion itself never landed.
      phoneInteractions,
    },
    // The live response contract, recorded by the first successful run. KEYS
    // ONLY — never values — so this diagnostic cannot leak a phone number, a
    // recording URL, or anything the provider echoed back.
    observedShape: {
      recordKeys: raw[0] ? Object.keys(raw[0]).slice(0, 60) : [],
    },
    moneyUnit: { verdict: moneyUnitVerdict, evidence: moneyEvidence },
    reconciliation: {
      passed: report.passed,
      summary: report.summary,
      // Ids are hashed: a mismatch stays traceable without exposing the id.
      missingInLoop: report.missingInLoop.map(handle),
      extraInLoop: report.extraInLoop.map(handle),
      aggregates: report.aggregates,
      // Metrics NOT compared because Loop and CallGrid measure different
      // business concepts. These are naming/mapping decisions, never failures.
      definitionMismatches: report.definitionMismatches,
      fieldMismatches: report.fieldMismatches.slice(0, 50).map((m) => ({
        ...m,
        metric: m.metric.replace(/\[([^\]]+)\]/, (_, id: string) => `[${handle(id)}]`),
        affected: m.affected.map(handle),
      })),
    },
    at: new Date().toISOString(),
  });
}
