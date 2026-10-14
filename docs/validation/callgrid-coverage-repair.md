# CallGrid coverage repair

## Verified incident

October 13, 2026 Eastern: Kaliper reported 492 calls/$2,827.54; Loop reported 394 calls/rounded $2,552. Kaliper's ACA RTB (73), Bathroom (7), FE CTV (14), FE CTV – Internal (1), and Spanish FE (3) groups total exactly 98 calls/$275.64. Removing them leaves 394/$2,551.90. This isolates the aggregate discrepancy; it does not certify a per-call join or prove a particular upstream configuration.

GitHub run 38578082034/job 115900383667 reported routine polling OFF because `ROUTINE_POLL_ORGANIZATIONS` was empty. Poll was skipped while the run was green. Webhooks continued arriving. Do not mistake transport activity for population coverage.

## What this change does

- Missing routine organization configuration now produces an error and a failed job.
- Every CallGrid reporting section and the integration detail page show routine checkpoint health separately from deliveries. Missing, unreadable, invalid, lagging, and stale checkpoints require attention. A recent checkpoint certifies only its recorded interval, not all historical days or the API credential's scope.
- Existing `billable*` metric keys remain stable for stored evidence, links, and clients. Their displayed name is **Monetized**, consistently across KPIs, rates, funnels, tables, briefs, Home, metric definitions, and new intelligence readings. The count is billable OR converted OR paid; the metric contract classifies it as derived. It is not an explicit provider billable count. No historical financial values are rewritten by this label correction.
- No schema migration or second ingestion path is introduced. Canonical identity, convergence, pagination gates, partial-apply semantics, and checkpoint advancement remain unchanged.

## Production procedure

1. Review and merge the PR, then verify the deployed commit. Repository policy reserves merging to Matt.
2. In CallGrid, compare Loop and Kaliper's account scope. Verify the five absent campaign groups have the intended event subscriptions and can be read with Loop's API credential. Compare IDs, not display names alone. Do not change routing, prices, or caps.
3. In GitHub repository Actions settings, set `ROUTINE_POLL_ORGANIZATIONS` to the verified organization slug (`servicesinmycity-demo` for the audited workspace). Verify the **presence** of `DIRECT_DATABASE_URL` and `CALLGRID_API_KEY`; do not print or copy their values into logs or the PR. A configured Netlify environment does not establish these GitHub secrets exist.
4. Dispatch Poll CallGrid Routine. Inspect the actual Poll step, outcome, fetched/applied counts, refusals/conflicts, and stored checkpoint. Failure or partial application must not advance it. Re-enable notifications or an external coverage monitor as appropriate; a failed workflow alone is not an incident response process.
5. Reconcile October 13 with CallGrid using the existing provider-day workflow/runner. This writes reconciliation evidence, not repaired calls. Request the exact Eastern day and inspect provider-only/Loop-only sets and attribution. Distinguish call legs from duplicate deliveries.
6. Dry-run historical recovery with the existing explicit interval runner, using secrets in the approved runtime:

   ```sh
   npm run recover:callgrid -- --organization servicesinmycity-demo \
     --since 2026-10-13T04:00:00Z --until 2026-10-14T04:00:00Z
   ```

   Dry run is the default. Review counts and refusals before using the existing manual recovery workflow's apply/confirmation controls. Do not invent an ad hoc SQL import. Recovery does not advance the routine checkpoint.
7. Reconcile again and verify exact cents and IDs by campaign, not only rounded dashboard totals. Resolve amount conflicts through evidence; do not overwrite settled facts to force a match with Kaliper. Replay to prove no additional canonical calls appear.
8. Inspect prior days to establish the affected interval, then recover explicit daily chunks. Initial routine bootstrap looks back one day; its 48-hour overlap is not an all-history recovery or a provider settlement guarantee.
9. Verify a missed webhook is recovered by a real routine pass. Inspect coverage health after a delayed/stopped poll as well as after successful ingestion. A CURRENT checkpoint is not an assertion that scheduler enablement is still on.

## Completion criteria

- All active campaign groups are accounted for or explicitly excluded with a documented reason.
- Provider-only and Loop-only identities are empty or explained; exact financial discrepancies and leg relationships are resolved.
- Real scheduled passes apply records and advance coverage; scheduler cadence is measured rather than assumed from cron.
- Missing polling configuration cannot produce a green ingestion result.
- Operators see stale/unproven recovery while webhooks remain fresh.
- Monetized outcomes, explicit provider billable flags, and Kaliper's campaign-specific detected conversions are not equated.

Until these production checks pass, this is a code fix prepared for rollout, not a certified data repair. Historical stored intelligence retains its original evidence; corrected producer readings are versioned and generated through normal refresh, not edited in place.
