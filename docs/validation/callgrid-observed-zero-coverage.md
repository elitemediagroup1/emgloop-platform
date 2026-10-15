# CallGrid explicit zero coverage

## Defect and correction

The projection preserves zero on initial creation, but re-observation previously retained null when incoming revenue/payout was explicitly zero. Thus identical provider data could yield different financial coverage depending on delivery order. A partial webhook followed by API zeroes could remain incomplete indefinitely.

The shared MONOTONIC_AMOUNT rule now fills an absent amount with an explicit source zero, records UPDATE through existing ingestion revisions, and still permits later zero-to-positive settlement. It never turns omitted input into zero or overwrites a known positive with zero. Different positive amounts remain conflicts. Costs retain their existing first-observation rule and reviewed correction path. Outcome flags retain their conservative false policy. No transport is promoted to authority and no final settlement state is invented.

## Evidence and limits

The user-provided October 15 18:02 CSV contains 432 distinct calls and explicit revenue/payout values for every row, including 302 paired zeroes. It has no telco costs or campaign column. Its population is later than the 411-call Loop answer. Exact Call ID matching and API payload review remain necessary to establish production parity. Aggregate rounding versus per-call cent rounding can differ by a penny.

## Validation and rollout

Shared full suite: 1,598 pass. Database full suite: 1,824 pass, 215 PostgreSQL integration tests skipped without a test database. Regression covers partial creation, explicit revenue/payout zero fill, replay, later positive settlement and protection against stale zeroes. Ingestion wiring asserts append-only UPDATE revision and unchanged false flags. Build/typecheck results are recorded in the PR; lint remains blocked by the existing missing ESLint configuration.

After Matt merges, the existing routine deep poll must reobserve source records. The patch itself does not repair production records or certify totals. Inspect coverage, revisions and conflicts after that pass. Known cost differences are not repaired here. Historical recovery remains explicitly selected and reviewed.

## Freshness findings

Frontier poll: ten-minute GitHub schedule, 15-minute overlap. Deep poll: hourly, 48-hour overlap, shared concurrency group. Installation and safety suites run before the provider read. Deep jobs may hold the group for up to 50 minutes. Intelligence worker default: 15 minutes, subject to activation and queueing. Dynamic pages read current stored state, but snapshots cannot certify upstream completeness. No measured scheduler delay distribution or Kaliper mechanism was obtained. This patch makes no unverified real-time claim and does not weaken scheduled safety checks.
