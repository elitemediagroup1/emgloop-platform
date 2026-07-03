# Brain / Buyer Call-Handling Briefing endpoint

Phase 1 — the first Brain runtime endpoint. Draft PR, additive, read-only.

## What it does

`GET /api/brain/call-handling-briefing`

1. Reads already-ingested/reconciled CallGrid interaction data for a
   caller-supplied window (`LiveOperationsRepository.listBrainCallWindow`,
   a new, additive method — it does not change `listLiveCalls` or any
   other existing method).
2. Assembles `CallHandlingMetrics` via the existing, unchanged assembler
   (`call-handling-metrics-assembler.ts`, from a prior Phase 1 PR).
3. Runs the existing, unchanged `BuyerCallHandlingDiagnoser`.
4. Converts the resulting `DiagnosticAssessment` through the existing,
   unchanged diagnostics->recommendation adapter.
5. Publishes an immutable `BrainActivity` (existing, unchanged publisher).
6. Projects that activity into a `BrainBriefing` (existing, unchanged
   projection).
7. Returns JSON only.

Steps 2-6 reuse `assembleAndRunCallHandlingFlow` (composes 2-5 end to
end) and `projectBrainBriefing` (step 6) exactly as merged in prior
Phase 1 PRs. This endpoint adds only the DB read (step 1) and the HTTP
wiring (step 7) — no new decision logic anywhere.

## Inputs (query params)

- `since`, `until` — ISO date strings bounding the analysis window.
- `days` — shorthand window size in days (default 30, max 365) used when
  `since` is omitted. `until` defaults to now.
- `vendor`, `buyer`, `source`, `campaign` — optional exact-match
  attribution filters.

The organization is always resolved from the session
(`resolveCrmOrganizationId`), exactly like every other route in this
codebase — it is never taken from a client-supplied id, so one tenant can
never read another tenant's window.

## Output (JSON)

- `window`, `filters`, `recordCounts` (`totalInteractions`,
  `classified`, `unclassified`).
- `metricsSummary` — the assembled `CallHandlingMetrics`, raw counts,
  billable/qualified rates, and preserved attribution.
- `diagnosticAssessmentSummary` — subject, state, confidence, findings,
  root causes, unknowns, and missing evidence.
- `recommendationSummary` — the recommendation envelope's decision
  fields (recommendation, action, root cause, suggested action, expected
  outcome, risk, business impact) plus its trust fields (confidence,
  missing evidence, unknowns, alternatives considered).
- `briefing` — the full `BrainBriefing` (this activity projected
  through the existing, unchanged projection).

Every "unknown" or "missing" field is surfaced explicitly (`null` or an
empty array), never silently omitted or fabricated.

## Honesty in the read path

The platform's stored call-status/event-type strings do not map 1:1 onto
the diagnoser's `CallStatus` vocabulary. This endpoint's `mapCallStatus`
classifies what it can (answer / complete / transfer / voicemail / miss /
no_answer / hangup / no_route) and, when a raw value cannot be confidently
classified, DROPS that record from the aggregation window rather than
guessing — the drop is counted in `recordCounts.unclassified` so nothing
is hidden. Likewise, `endedBy` is left `undefined` (never fabricated)
whenever the platform has not captured it for a call, which today is the
common case; the existing diagnoser already treats an absent metric as
honestly missing rather than a confident zero, and the existing 'unknown'
assessment path already covers the case where the window is too small or
the signals conflict.

## Security

Gated behind `can('intelligence', 'manage')` — the existing deny-by-default
capability matrix (`iam.repository.ts`) already grants the `manage`
action on the `intelligence` resource to OWNER and ADMIN roles only;
MANAGER/EMPLOYEE/READ_ONLY carry `view` only and are therefore denied.
This is the platform's existing internal/admin gate — no new permission
resource, action, or schema was introduced. A forbidden request, and any
unexpected server error, both return JSON (`{ ok: false, error: ... }`)
with an appropriate status code — never Next's default HTML error page.

## What it does NOT do

- No writes of any kind; no BrainActivity persistence; no triggered
  actions.
- No change to `listLiveCalls` or any existing repository method — the
  Live Calls feed, Traffic, and Revenue pages are untouched.
- Not linked from, and does not affect, any existing page.
- No LLM, no experiments, no knowledge-layer coupling, no schema changes.

## Constraints honored

No schema changes · no UI · no DB writes · no ingestion changes · no
CallGrid behavior changes · no LLM · no experiments · no knowledge layer.
Draft PR — do not merge.
