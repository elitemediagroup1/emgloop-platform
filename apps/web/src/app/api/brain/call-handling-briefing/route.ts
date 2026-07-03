import { NextResponse } from 'next/server';
import { crmRepos, resolveCrmOrganizationId } from '../../../../crm/crm-data';
import { can } from '../../../../auth/auth';
import type { CallWindow, ReconciledCallRecord, CallStatus, CallEndedBy } from '@emgloop/brain';
import { assembleAndRunCallHandlingFlow, projectBrainBriefing } from '@emgloop/brain';

// Brain / Buyer Call-Handling Briefing — Phase 1 (first Brain runtime endpoint).
//
// Read-only, internal diagnostic preview. It:
// 1. Reads already-ingested/reconciled CallGrid interaction data (a
//    caller-ranged window, via the new LiveOperationsRepository.listBrainCallWindow).
// 2. Assembles CallHandlingMetrics via the existing, unchanged assembler
//    (call-handling-metrics-assembler.ts).
// 3. Runs the existing, unchanged BuyerCallHandlingDiagnoser.
// 4. Converts the DiagnosticAssessment through the existing, unchanged
//    diagnostics->recommendation adapter.
// 5. Publishes a BrainActivity (existing, unchanged publisher).
// 6. Projects the BrainActivity into a BrainBriefing (existing, unchanged
//    projection).
// 7. Returns JSON only.
//
// Every step above (2-6) is untouched code from prior, already-merged Phase 1
// PRs (assembleAndRunCallHandlingFlow composes steps 2-5 end to end;
// projectBrainBriefing is step 6). This file adds ONLY the read (step 1) and
// the HTTP wiring (step 7) — no new decision logic anywhere.
//
// STRICTLY READ-ONLY: no writes, no BrainActivity persistence, no triggered
// actions, and no change to any existing CRM/Live/Traffic/Revenue behavior —
// this route is not linked from, and does not affect, any existing page.
//
// Security: gated behind the existing 'intelligence' resource at the 'manage'
// action. In the deny-by-default capability matrix (iam.repository.ts) only
// OWNER and ADMIN carry 'manage' on 'intelligence' — MANAGER/EMPLOYEE/
// READ_ONLY carry only 'view'. This is the platform's existing internal/admin
// gate; no new permission resource, action, or schema was introduced.
// Unauthorized/forbidden and any unexpected error both return JSON (never
// Next's default HTML error page).

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

function parseDateParam(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Resolve the [since, until] analysis window from query params. Defaults to
 * the trailing DEFAULT_WINDOW_DAYS days ending now when no explicit range is
 * given. Deterministic given explicit since/until; 'now'-anchored only when
 * the caller omits both, which is the same honest behavior every other
 * read-only dashboard route in this codebase already uses. */
function resolveWindow(url: URL): { since: Date; until: Date } {
  const now = new Date();
  const sinceParam = parseDateParam(url.searchParams.get('since'));
  const untilParam = parseDateParam(url.searchParams.get('until'));
  const until = untilParam ?? now;
  if (sinceParam) return { since: sinceParam, until };
  const daysRaw = Number(url.searchParams.get('days'));
  const days =
    Number.isFinite(daysRaw) && daysRaw > 0
      ? Math.min(MAX_WINDOW_DAYS, Math.floor(daysRaw))
      : DEFAULT_WINDOW_DAYS;
  return { since: new Date(until.getTime() - days * DAY_MS), until };
}

/** Map the platform's raw stored call-status/event-type string onto the
 * diagnoser's CallStatus vocabulary. Order matters: more specific patterns
 * (no_route, no_answer) are checked before the broader 'answer' pattern they
 * would otherwise match as a substring. Returns null when the raw value
 * cannot be honestly classified — the caller drops that record (counted as
 * 'unclassified' in the response) rather than guessing a status. */
function mapCallStatus(raw: string | null): CallStatus | null {
  const k = (raw ?? '').toLowerCase();
  if (!k) return null;
  if (/no.?route/.test(k)) return 'no_route';
  if (/no.?answer/.test(k)) return 'no_answer';
  if (/miss/.test(k)) return 'miss';
  if (/voicemail/.test(k)) return 'voicemail';
  if (/transfer/.test(k)) return 'transfer';
  if (/complete/.test(k)) return 'complete';
  if (/hangup/.test(k)) return 'hangup';
  if (/answer/.test(k)) return 'answer';
  return null;
}

/** Map a raw who-ended string onto the diagnoser's CallEndedBy vocabulary.
 * Returns undefined (honestly unknown) rather than guessing — the platform
 * does not capture this field on every call today, and that absence must
 * surface as missing evidence, never a fabricated value. */
function mapEndedBy(raw: string | null): CallEndedBy | undefined {
  const k = (raw ?? '').toLowerCase();
  if (k === 'buyer') return 'buyer';
  if (k === 'caller') return 'caller';
  if (k === 'system') return 'system';
  if (k === 'unknown') return 'unknown';
  return undefined;
}

export async function GET(req: Request) {
  try {
    const allowed = await can('intelligence', 'manage');
    if (!allowed) {
      return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }

    const orgId = await resolveCrmOrganizationId();
    if (!orgId) {
      return NextResponse.json({ ok: true, orgReady: false });
    }

    const url = new URL(req.url);
    const { since, until } = resolveWindow(url);
    const vendor = url.searchParams.get('vendor') ?? undefined;
    const buyer = url.searchParams.get('buyer') ?? undefined;
    const source = url.searchParams.get('source') ?? undefined;
    const campaign = url.searchParams.get('campaign') ?? undefined;

    const rawRows = await crmRepos.liveOperations.listBrainCallWindow(orgId, {
      since,
      until,
      vendor,
      buyer,
      source,
      campaign,
    });

    const records: ReconciledCallRecord[] = [];
    let unclassified = 0;
    for (const row of rawRows) {
      const status = mapCallStatus(row.callStatusRaw);
      if (!status) {
        unclassified += 1;
        continue;
      }
      records.push({
        id: row.id,
        status,
        durationSeconds: row.durationSeconds ?? undefined,
        endedBy: mapEndedBy(row.endedByRaw),
        billable: row.billable ?? undefined,
        qualified: row.qualified ?? undefined,
        vendorId: row.vendor ?? undefined,
        buyerId: row.buyer ?? undefined,
        source: row.source ?? undefined,
        campaign: row.campaign ?? undefined,
      });
    }

    const windowRef = [
      'call-handling-briefing',
      orgId,
      since.toISOString(),
      until.toISOString(),
      vendor ?? '',
      buyer ?? '',
      source ?? '',
      campaign ?? '',
    ].join('|');
    const subject = buyer ? 'buyer:' + buyer : 'call_handling_root_cause';
    const now = new Date();

    const window: CallWindow = {
      organizationId: orgId,
      records,
      windowRef,
    };

    const { assembled, flow } = assembleAndRunCallHandlingFlow({
      window,
      subject,
      activityId: windowRef,
      timestamp: now,
    });

    const briefing = projectBrainBriefing({ activities: [flow.activity] });

    return NextResponse.json({
      ok: true,
      orgReady: true,
      window: { since: since.toISOString(), until: until.toISOString() },
      filters: {
        vendor: vendor ?? null,
        buyer: buyer ?? null,
        source: source ?? null,
        campaign: campaign ?? null,
      },
      recordCounts: {
        totalInteractions: rawRows.length,
        classified: records.length,
        unclassified,
      },
      metricsSummary: {
        sampleSize: assembled.metrics.sampleSize,
        answerRate: assembled.metrics.answerRate ?? null,
        buyerEndedRate: assembled.metrics.buyerEndedRate ?? null,
        callerEndedRate: assembled.metrics.callerEndedRate ?? null,
        noRouteRate: assembled.metrics.noRouteRate ?? null,
        shortCallRate: assembled.metrics.shortCallRate ?? null,
        avgDurationSeconds: assembled.metrics.avgDurationSeconds ?? null,
        billableRate: assembled.billableRate ?? null,
        qualifiedRate: assembled.qualifiedRate ?? null,
        counts: assembled.counts,
        attribution: assembled.attribution,
      },
      diagnosticAssessmentSummary: {
        subject: flow.assessment.subject,
        state: flow.assessment.state,
        confidence: flow.assessment.confidence,
        findings: flow.assessment.findings.map((f) => ({
          subject: f.subject,
          statement: f.statement,
          severity: f.severity,
          confidence: f.confidence,
          state: f.state,
        })),
        rootCauses: flow.assessment.rootCauses.map((rc) => ({
          category: rc.category,
          hypothesis: rc.hypothesis,
          rationale: rc.rationale,
          confidence: rc.confidence,
        })),
        unknowns: flow.assessment.unknowns,
        missingEvidence: flow.assessment.missingEvidence,
      },
      recommendationSummary: {
        recommendation: flow.envelope.recommendation,
        action: flow.envelope.action,
        rootCause: flow.envelope.rootCause,
        reason: flow.envelope.reason,
        suggestedAction: flow.envelope.suggestedAction,
        expectedOutcome: flow.envelope.expectedOutcome,
        risk: flow.envelope.risk,
        businessImpact: flow.envelope.businessImpact,
        confidence: flow.envelope.trust.confidence,
        missingEvidence: flow.envelope.trust.missingEvidence,
        unknowns: flow.envelope.unknowns,
        alternativesConsidered: flow.envelope.alternativesConsidered,
      },
      briefing,
      at: now.toISOString(),
    });
  } catch (err) {
    // Always return JSON, even on an unexpected failure — never let this
    // diagnostic endpoint fall back to Next's default HTML error page.
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'internal_error' },
      { status: 500 },
    );
  }
}
