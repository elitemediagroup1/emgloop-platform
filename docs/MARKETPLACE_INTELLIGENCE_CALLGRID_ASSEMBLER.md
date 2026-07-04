# Marketplace Intelligence — CallGrid Assembler (PR #44)

**Status:** Draft. Contracts + one pure function. Not wired into any runtime path.
**Depends on:** PR #43 (Marketplace Intelligence Canonical Domain Model), \`@emgloop/shared\`, \`@emgloop/brain\`.
**Precedent mirrored:** \`packages/brain/src/call-handling-metrics-assembler.ts\`.

## Objective

PR #43 established the canonical, provider-neutral **Marketplace Intelligence**
model that every future consumer reads from. This PR adds the first *sensor*
that can populate it: a pure, read-only assembler that projects **already
reconciled CallGrid report facts** into that canonical shape — without changing
the model, touching the database, calling CallGrid, wiring runtime, or invoking
any LLM.

CallGrid is treated as a **Sensor, never the product**. All CallGrid-specific
vocabulary is confined to a single input-boundary file; everything the assembler
emits is the sensor-neutral PR #43 model.

## What this PR delivers

Two new files, one updated barrel, and this document.

- \`packages/marketplace-intelligence/src/callgrid-input.ts\` — the CallGrid input
  boundary. Read-only view types for the three reports the platform already
  fetches and reconciles: \`/api/reports/bidStats\`, \`/api/reports/bidStats/rejections\`,
  and \`/api/reports/stats\`. Field names mirror the CallGrid API 1:1. This is the
  **only** file allowed to speak CallGrid's language.
- \`packages/marketplace-intelligence/src/callgrid-assembler.ts\` — a deterministic,
  pure projection from \`CallGridReportInput\` into \`MarketplaceIntelligence\`. No
  I/O, no clock, no RNG, no persistence, no mutation of inputs, no LLM.
- \`packages/marketplace-intelligence/src/index.ts\` — barrel updated additively to
  export the two new modules. PR #43 exports are unchanged.
- \`docs/MARKETPLACE_INTELLIGENCE_CALLGRID_ASSEMBLER.md\` — this file.

## Data flow

\`\`\`
Reconciled CallGrid report rows (already fetched by the platform)
     │  callgrid-input.ts  (CallGrid vocabulary isolated here)
     ▼
CallGridReportInput
     │  callgrid-assembler.ts  (pure, read-only projection)
     ▼
MarketplaceIntelligence  (PR #43 canonical, sensor-neutral snapshot)
\`\`\`

## Mapping (CallGrid → canonical)

| CallGrid input | Canonical target | Notes |
| --- | --- | --- |
| \`bidStats\` rows | \`SourceIntelligence[]\` | \`bids→bidsSent\`, \`rated→bidsAccepted\`, \`won→bidsWon\`. |
| \`bidStats/rejections\` rows | \`SourceIntelligence.rejectReasons[]\` | CallGrid reason columns → neutral \`reason\` strings + \`count\`. |
| \`stats\` rows pivoted \`CampaignName\` | \`CampaignIntelligence[]\` | revenue/payout/cost/profit/margin passthrough; call counts where present. |
| \`stats\` rows pivoted \`BuyerName\` | \`BuyerIntelligence[]\` | revenue/payout/profit; \`billableRate\`/\`conversionRate\` only from a row's own counts. |
| \`stats\` rows pivoted \`VendorName\` | \`VendorIntelligence[]\` | revenue/profit passthrough. |
| \`stats\` totals | \`MarketplaceProfitability\` | revenue/payout/cost/telco/grossProfit/netProfit/margin summed, never derived. |
| \`bidStats\` + \`stats\` totals | \`MarketplaceFunnel\` | default pay-per-call stages; unknown stages omitted, never zero-filled. |

### Metrics that are NOT first-class in the canonical model

Per the task rule, any CallGrid metric the PR #43 model does not name as a
first-class field is preserved in \`metadata\` rather than by changing the model.
Examples carried under \`metadata.callgrid\`: \`totalBidAmount\`, \`totalWonAmount\`,
\`avgBid\`, \`avgWinningBid\`, \`winRate\`, \`bidRate\`, \`rejectRate\`, total ping counts,
the full rejection breakdown, and each stats row's raw metric map. The canonical
model is untouched.

## Honesty: no fabricated insight

The Brain (diagnostics, recommendations, Brain Activity) is **not wired** to
Marketplace Intelligence yet. This assembler therefore **never fabricates**
recommendations or insights:

- \`recommendations\` and \`insights\` are always empty.
- \`health\`, buyer/vendor \`quality\`, and source \`callQuality\` default to
  \`'unknown'\`.
- \`confidence\` is \`0\` (this projection runs no diagnosis and claims no
  interpretive confidence).
- \`missingEvidence\` carries a single explicit marker (\`BRAIN_NOT_WIRED\`) so
  consumers see *why* the interpretive fields are empty rather than a silent gap.
- Metrics whose evidence is absent stay \`undefined\`, never a fabricated \`0\`.

## Constitutional principles satisfied

- **Sensor, not product.** CallGrid vocabulary is quarantined to \`callgrid-input.ts\`;
  the output is the neutral canonical model.
- **Reuse over redeclaration.** \`Confidence\` and every canonical type are imported
  from \`@emgloop/brain\` / PR #43; nothing is duplicated.
- **Explainable / honest about ignorance.** Unknowns and missing evidence are
  first-class and never omitted.
- **Additive and non-invasive.** No existing file's behavior changes; no schema,
  API, UI, DB, or runtime wiring is touched.

## Verification

- Three new/updated files under \`packages/marketplace-intelligence/src\` plus this
  doc; the PR #43 model files are unmodified.
- The assembler imports only PR #43 canonical types and \`@emgloop/brain\`; it
  fetches nothing and mutates nothing.
- No recommendations/insights are produced; interpretive fields are empty and
  annotated with \`BRAIN_NOT_WIRED\`.

## Recommended next PR

**PR #45 — Wire the Brain to Marketplace Intelligence:** feed the assembled
snapshot's entities through the existing diagnostic + recommendation +
Brain-Activity pipeline so \`recommendations\`, \`insights\`, \`health\`, and
\`confidence\` are populated by the Brain (removing \`BRAIN_NOT_WIRED\`) — still with
no UI/API/DB coupling, deciding surfacing separately.
