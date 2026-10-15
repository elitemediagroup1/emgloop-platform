# CallGrid recovery and reviewed cost corrections

## Observed production gap

On October 15 at about 09:26 Eastern, CallGrid and Kaliper showed 8 calls for today; Loop showed 3. A rerun of the enabled routine job processed 950 records, recovered 6 new events, retained 8 conflicts, and advanced coverage through 09:30:39.523 Eastern. At 09:36 Loop showed 10 calls. No historical financial overwrite was performed.

For October 14, all nine campaigns' revenue matched across the three UIs and Kaliper/Loop campaign call counts matched (448 total). CallGrid/Loop payout was $2,226.27; billable/monetized count 107. Costs remained $60.32/$53.20 respectively. Campaign differences are Home Insurance $2.40, Auto RTB $1.68, Pest Control RTB $0.32, FE CTV $2.72. The eight logged conflicts are consistent with changed-cost refusal, but have not been matched to these differences call by call. Do not allocate campaign differences to individual calls.

## Routine freshness

The existing workflow now requests frontier passes at minutes 3/13/23/33/43/53, with 15 minutes of overlap. An hourly deep pass at minute 7 retains the full 48-hour overlap. Manual dispatch defaults to deep. Both share one concurrency group and the same checkpoint and canonical ingestion. The frontier starts from the last proven checkpoint minus its overlap, so a delayed job reads its entire unproven gap. Bootstrap remains one day. A failed/incomplete pass never advances coverage. Frontier jobs time out after ten minutes; deep jobs after fifty.

At the previously observed maximum of 7,298 daily calls, six 25-minute frontier rereads plus one 48-hour deep reread per hour are roughly 5.2% more records than hourly deep alone, instead of multiplying two days of traffic by six. This is an approximate load budget, not a provider rate-limit guarantee. Long outages, burst traffic and startup tests add time. GitHub can delay or drop scheduled runs: this is an improved recovery cadence, not guaranteed real-time delivery. Verify webhook campaign/event subscriptions separately; this patch changes no CallGrid account settings.

## Correct one completed day's costs

1. After merging, GitHub Actions → **Correct CallGrid Costs** → Run workflow on **main**.
2. Organization `servicesinmycity-demo`, business date `2026-10-14`, mode **preview**. Leave digest and confirmation empty. Preview performs no writes.
3. Download the `callgrid-cost-correction` JSON artifact (seven-day retention). Review each call identity, old/new cents, campaign, business window and digest. Evidence includes the whole day's local/source cost snapshot. Revenue/payout unknowns remain unknown. Unmatched/incomplete/capped/duplicate evidence or any missing provider cost prevents a usable plan; an empty day produces no changes; at most 500 changed calls are accepted.
4. Apply only after review: same organization/date, mode **apply**, paste the preview's `plan.digest`, and type `CORRECT COSTS servicesinmycity-demo 2026-10-14`. The workflow records the GitHub actor.
5. Apply rereads CallGrid and Loop. A changed digest refuses the write; preview/review again. Each stored cost is compared at write time. One stale call, foreign organization or failed revision insert rolls back all changes. Explicit decreases and zero are possible only through this reviewed path. It appends `UPDATE` cost revisions with reviewer/digest/old/new cents and changes only `MarketplaceCall.costCents` atomically; old evidence and conflicts remain untouched. Ordinary ingestion cannot replace the corrected known cost with an older differing value.
6. Run **Audit CallGrid Financials** for the same completed day and compare campaign costs, net profit and identities to CallGrid's report UI. A successful apply is not a parity certificate. Unknown revenue/payout zero values may keep the audit inconclusive despite matching reported sums.

Only the existing organization allowlist and repository secrets are used. There is no schedule on the correction workflow, no schema migration, and no automatic financial-write activation by merging. This deliberately does not invent a settlement SLA or latest-payload-wins policy. Future known-cost differences still require review until provider version/settlement evidence supports automatic corrections.
