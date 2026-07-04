# Marketplace Intelligence — CallGrid Assembler Verification (PR #45)

**Status:** Draft. Pure, framework-free verification harness. Not wired into any runtime path.
**Depends on:** PR #44 (CallGrid Assembler), PR #43 (Canonical Model).
**Precedent mirrored:** \`packages/brain/src/call-handling-assembler-verification.ts\`.

## Objective

Prove — deterministically and without a test runner — that the PR #44 CallGrid
assembler projects fixed CallGrid report rows into the PR #43 canonical,
provider-neutral Marketplace Intelligence model correctly. The harness builds
**fixed sample** \`bidStats\`, \`rejections\`, and \`stats\` rows, runs the **real**
assembler functions over them, and records pass/fail checks in a structured
report.

Consistent with repo tooling (only \`typecheck\`/\`build\` via turbo — no test
runner, and none may be added), the harness is a set of **pure functions**. It
performs no I/O, no persistence, no DB reads/writes, touches no CallGrid path,
uses no LLM, adds no UI/API, and is wired into no runtime. It compiles as part of
the normal typecheck/build; a caller may additionally invoke
\`runCallGridAssemblerVerification()\` to execute the checks at runtime.

## Files

- \`packages/marketplace-intelligence/src/callgrid-assembler-verification.ts\` —
  fixtures, a tiny internal \`Checker\`, eight scenarios, and the
  \`runCallGridAssemblerVerification()\` entry point returning a
  \`VerificationReport\`.
- \`packages/marketplace-intelligence/src/index.ts\` — barrel updated additively to
  export the harness. PR #43/#44 exports unchanged.
- \`docs/MARKETPLACE_INTELLIGENCE_CALLGRID_ASSEMBLER_VERIFICATION.md\` — this file.

## Fixtures

- \`BID_STATS_ROWS\` — two sources: one fully specified (\`src-1\`), one minimal
  (\`src-2\`, no \`sourceName\`) to prove the name falls back to \`sourceId\`.
- \`REJECTION_ROWS\` — one row for \`src-1\` mixing present, zero, and absent reason
  counts, to prove zeros/absents are dropped.
- \`STATS_ROWS\` — one row per pivot (\`CampaignName\`, \`BuyerName\`, \`VendorName\`)
  with fixed metric maps, including deliberately absent metrics.
- \`SPARSE_INPUT\` — a single \`bidStats\` row with only \`bids\`, to prove missing
  values stay \`undefined\` and unknown funnel stages are omitted.

## What is verified (eight scenarios)

1. **Source bid metrics map correctly** — \`bids→bidsSent\`, \`rated→bidsAccepted\`,
   \`won→bidsWon\`; \`sourceName\` falls back to \`sourceId\`; non-canonical CallGrid
   metrics (\`winRate\`, \`totalBidAmount\`, …) live in \`metadata.callgrid\`, not on
   the entity.
2. **Rejection reasons map correctly** — CallGrid reason columns map to neutral
   strings (\`callerId→caller_id_blocked\`, etc.); zero/absent reasons are dropped;
   exactly the expected reasons are emitted.
3. **Campaign/buyer/vendor stats map correctly** — rows route by pivot;
   revenue/payout/cost/margin passthrough; \`profit\` prefers \`net_profit\` and
   falls back to \`gross_profit\`; buyer row-local ratios (\`billableRate\`,
   \`conversionRate\`) compute from that row's own counts; no cross-routing.
4. **Profitability totals map correctly** — each field is the sum of that metric
   across all stats rows (any pivot); fields absent from every row stay
   \`undefined\`.
5. **Funnel stages are ordered correctly** — the eight default pay-per-call
   stages appear in canonical order with dense, ascending \`order\` from 0, and
   representative counts are summed across rows.
6. **Missing values stay undefined** — sparse inputs leave dependent metrics
   \`undefined\` (never a fabricated \`0\`); unknown funnel stages are omitted and
   survivors re-indexed densely; buyer ratios stay \`undefined\` without a
   denominator.
7. **\`BRAIN_NOT_WIRED\` appears where expected** — the top-level snapshot, every
   entity's \`missingEvidence\`, profitability's \`missingEvidence\`, and
   \`metadata.note\` all carry the marker; recommendations/insights are empty and
   confidence is \`0\`.
8. **Output remains provider-neutral** — a structural key walk (excluding the
   sanctioned \`metadata\` subtree) confirms no CallGrid-specific column names
   (\`winRate\`, \`total_revenue\`, \`callerId\`, …) leak into canonical fields, while
   the canonical identifiers (\`sourceId\`, \`campaignId\`, \`buyerId\`, \`vendorId\`)
   are present; the sensor is named only under \`metadata\`.

## Verification of the harness itself

Deterministic and pure: fixtures pin all dates and values, so
\`runCallGridAssemblerVerification()\` yields the same \`VerificationReport\` every
run. It imports only PR #44 assembler exports and PR #44 input types; it mutates
nothing and reads nothing external.

## Recommended next PR

**PR #46 — Wire the Brain to Marketplace Intelligence** (as noted in PR #44):
once the diagnostic + recommendation + Brain-Activity pipeline populates
\`recommendations\`/\`insights\`/\`health\`/\`confidence\` (removing \`BRAIN_NOT_WIRED\`),
extend this harness with scenarios asserting those fields are populated — still
with no UI/API/DB coupling.
