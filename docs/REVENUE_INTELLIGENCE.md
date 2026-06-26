# REVENUE_INTELLIGENCE.md — Revenue Events

Revenue Intelligence (`packages/brain/src/revenue.ts`) lets the Brain understand
**what created revenue**, not merely that money moved. No payment provider is
integrated in Sprint 12; these are contracts only.

## Payment vs Revenue Event

- A **Payment** is a raw money-movement record (amount, currency, time) that a
  future payment provider would deliver.
- A **Revenue Event** is a higher-order, attributed record: it links revenue back
  to the signals, interactions, campaigns, or creators the Brain believes caused
  it, with a confidence score.

## Revenue categories

Revenue Event, Commission, Affiliate, Lead Sale, Agency Revenue, Marketplace
Revenue, Creator Revenue, Revenue Opportunity, and Revenue Loss (negative).

## Attribution

Each Revenue Event carries an `attribution[]` array of links. Each link names what
drove the revenue (signal | interaction | campaign | creator | ...), a reference
id, a weight (share of attribution), and a reason. This is how the Brain learns
which activities actually produce revenue.

## Contract

`RevenueIntelligence` exposes `attribute(payment)` (promote a raw payment into an
attributed event) and `record(event)` (log a non-payment revenue event such as a
lead sale or a loss). Deterministic in Sprint 12.
