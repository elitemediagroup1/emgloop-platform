# Marketplace Intelligence — Canonical Domain Model

Status: Draft (PR #43). Contracts only. No runtime wiring, no UI, no database, no API, no LLM, no persistence.

## Why this exists

CallGrid is a Sensor. Ringba, Invoca, Twilio, Salesforce, HubSpot, Meta, Google Ads, TikTok, and any future internal bidding system are also Sensors. Marketplace Intelligence is the product: the durable, sensor-agnostic business abstraction that every consumer of marketplace data reads from, forever. A prior CallGrid bid-facts audit surfaced the metrics available today (see `docs/CALLGRID_RECONCILIATION.md`), but this model is deliberately NOT shaped around CallGrid's vocabulary. Where CallGrid says "Campaign", "Buyer", "Source", "Vendor", this model says Campaign Intelligence, Buyer Intelligence, Source Intelligence, Vendor Intelligence — business concepts a future Ringba, Invoca, or internal bidding integration can populate identically.

## Package

`packages/marketplace-intelligence` — a new workspace package, structured like `@emgloop/brain`: a barrel (`src/index.ts`) over a set of contracts-only TypeScript files. It depends on `@emgloop/shared` (TenantScope, Metadata) and `@emgloop/brain` (Confidence, RecommendationEnvelope, BrainActivity, DiagnosticAssessment) — nothing is duplicated from either.

## Model summary

- **MarketplaceIntelligence** — the top-level, per-organization, per-window snapshot. References every other type below plus `recommendations` (RecommendationEnvelope[]) and `insights` (MarketplaceBrainInsight[], aliasing BrainActivity).
- **CampaignIntelligence / BuyerIntelligence / SourceIntelligence / VendorIntelligence** — one entry point per marketplace participant, all extending the shared `MarketplaceEntityIntelligence` envelope (id, name, sensor, timeWindow, confidence, trends, recommendations, unknowns, missingEvidence).
- **MarketplaceFunnel** — an ordered, open-ended set of `MarketplaceFunnelStage`s (key/label/count/order) representing the lifecycle (bids to accepted to won to calls to completed to billable to revenue to profit as the default, not a constraint). New stages never require a redesign.
- **MarketplaceProfitability** — revenue, payout, cost, telco, gross profit, net profit, margin. Domain representation only; no calculation logic lives here.
- **MarketplaceBrainInsight** — a direct type alias of `BrainActivity`. No new insight shape was invented; the existing Brain output is reused verbatim.

## Constitutional principles satisfied

- **The Brain owns decisions.** This model never generates a recommendation; it only carries `RecommendationEnvelope`/`BrainActivity` objects the Brain already produced.
- **Sensors emit facts only.** Every entity's `sensor` field records provenance as an open string, never a hardcoded enum tied to CallGrid.
- **Unknown is a valid first-class value.** Every numeric metric is optional; `unknowns`/`missingEvidence` arrays are present at every level rather than defaulting absent data to zero.
- **Everything explainable.** Recommendations and insights are always the existing, fully-explained Brain contracts (`RecommendationEnvelope`, `BrainActivity`) — never a stripped-down or duplicated shape.
- **Reuse over redeclaration.** Confidence, RecommendationEnvelope, DiagnosticAssessment, and BrainActivity are all imported from `@emgloop/brain`, never redefined.

## Why this is future-proof

Every domain-specific interface is additive and open: `MarketplaceSensorId` is a union of known literals widened with `string & {}` so a brand-new sensor (or a future Creator Intelligence / Enterprise portal source) needs no type change. `MarketplaceFunnelStage.key`/`order` allow any lifecycle shape, not only the pay-per-call bid funnel. `MarketplaceRejectReason.reason` is an open string so new rejection semantics from a new sensor slot in without a redesign. No field assumes CallGrid, bidding, or even phone calls — a Creator Intelligence marketplace (followers, views, brand deals) or an advertising marketplace (impressions, clicks, conversions) can populate the same `MarketplaceEntityIntelligence` envelope.

## What can be built now vs. what waits

This PR delivers types only — no code reads or writes them yet. The next PR is expected to define a pure, unwired assembler (mirroring `packages/brain/src/call-handling-metrics-assembler.ts`) that projects already-reconciled CallGrid facts (Call Ended + Bid Received webhook data, `/api/reports/bidStats`, `/api/reports/bidStats/rejections`, `/api/reports/stats`) into this canonical shape — read-only, non-invasive, and wired into no live path until a separate decision is made to do so.

## Recommended next PR

PR #44 — Marketplace Intelligence CallGrid Assembler (pure, unwired): a deterministic function that takes reconciled CallGrid records (mirroring `ReconciledCallRecord`/`CallWindow` conventions) and produces a `MarketplaceIntelligence` object, following the exact non-invasive precedent already established by the call-handling metrics assembler. Draft PR only; never merged; no runtime wiring.
