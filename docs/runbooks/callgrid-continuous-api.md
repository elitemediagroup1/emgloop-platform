# Continuous CallGrid API reader

## What ships

The existing connections worker can host an API-only CallGrid frontier reader. It starts immediately and ticks every 30 seconds while enabled. Each tick reuses CallGridRoutinePollService, canonical ingestion, append-only fact revisions and the same durable checkpoint. The live path retains the 15-minute overlap but requests through the current clock rather than stopping two minutes behind it. Deep rereads stay available for delayed financial facts. Known conflicting amounts are not silently overwritten.

A read already running is reused, never overlapped inside the process. Failed or incomplete coverage causes exponential cooldown, up to five minutes. A failed checkpoint is not advanced. Failed or suspended organization resolution refuses source reads. Logs contain outcomes, elapsed time, counts and coverage age, never keys or source payloads. Shutdown stops new reads and waits for the current one before database disconnection.

Changed calls request the existing intelligence pass without awaiting model work. An already running intelligence pass queues one coalesced follow-up. Existing provider policies, task allowlists, per-person authorization, validation and operating budgets still apply. This does not guarantee a new model-written briefing after every call. Model refusal may yield the existing honest deterministic fallback. No page render triggers a source fetch, model call or database write.

30 seconds is a target tick interval, not a verified end-to-end latency SLA. API response time, ingestion work, throttling and upstream delayed postbacks remain real. Home and read-only CallGrid report views re-read their stored server view every 15 seconds while visible, pausing during editing or while Ask Loop is open. Returning to a visible tab also refreshes it. This is a small client leaf; views remain server-rendered and the refresh does not call CallGrid or invoke a model. Overview and Intelligence retain navigation/manual refresh because their existing loader records detections; automatically repeating that write path is deliberately excluded. Their initial page load still reads current stored calls. A rolling deployment can briefly have two worker processes. Canonical ingestion/checkpoints remain idempotent, but duplicated reads share the API-key rate limit. Existing GitHub deep/frontier jobs may also read that key. Watch rate-limit counts and proven coverage, not just task health.

## Commission one stage

1. Review/merge the PR. Netlify deployment alone does not deploy this worker.
2. In AWS Secrets Manager in the intended workload account/region, create the operator-provided secret `loop/connections/staging/callgrid` (production: `loop/connections/production/callgrid`) with JSON field `api_key` holding the existing approved CallGrid API key. Preserve the current key scope. Never paste the value in logs, chat, GitHub variables or a PR. This references a secret; the CDK stack does not create its value.
3. On the GitHub `connections-staging` environment set `CONNECTIONS_STAGING_CALLGRID_ORGANIZATION` to the approved organization slug for that API account. For production use `connections-production` / `CONNECTIONS_PRODUCTION_CALLGRID_ORGANIZATION`. For EMG the already configured scope is `servicesinmycity-demo`; do not bind that credential to an unrelated organization. Empty means off and no CallGrid secret reference is synthesized.
4. Run `connections-infra-deploy` action **diff**, selecting the stage. Confirm only the existing worker’s environment, stage-scoped secret access and image are changing, with no extra public access. Then run action **deploy** with the existing required confirmation. Staging first. No migration.
5. In worker logs verify `callgrid_api_host` scheduled true and repeated `callgrid_api_pass`. Inspect `coverageThrough`, `coverageLagMs`, `elapsedMs`, fetched/created/strengthened/conflicts and `proven`. A successful read with conflicts still requires financial review. No key appears in logs.
6. Confirm a new source Call ID appears in Loop, and match record amounts against the same source cutoff. Measure observed source-to-ingestion age and report it. Test a failed provider read and confirm no false checkpoint advance. Confirm changed calls lead to a new authorized reading/briefing or a named policy/budget limitation.
7. Keep hourly deep polling as recovery. The GitHub routine jobs can remain fallback during commissioning. The worker does not rely on webhooks or on GitHub scheduled startup for fresh calls. Do not disable existing webhooks as a side effect of rollout.

To turn off: clear the stage variable and redeploy that stage. Existing stored records and checkpoints remain. Do not delete records or checkpoints to restart.

## Provider and comparison evidence

CallGrid official API documentation: https://callgrid.com/api . Calls use /api/call, startDate/endDate, useCursor, maxItems and searchAfter. General published allowance is 80 requests/minute per key; the actual response headers and 429 govern. The client retains Retry-After precedence and uses RateLimit-Reset seconds when that header is absent on a 429. Requests have a 20-second timeout; no API key is printed or fetched through a browser workaround.

Kaliper: https://thekaliper.com/articles/getting-started documents API credential verification and background sync. https://thekaliper.com/articles/setting-up-relay describes a distinct ping Relay and six-hour configuration sync. This does not reveal the call-read cadence. https://thekaliper.com/articles/monitoring-calls states that filtered totals and the table share the profile timezone. Compare actual account settings/call IDs, not an assumed backend design.

## Source check after MCP connection

On October 15 around 20:58 Eastern, the authenticated CallGrid summary report returned 474 calls/148 billable with revenue $2,965.90, payouts $2,451.96 and cost $80.72. Around 21:00 Loop Money had the same counts, revenue $2,965.91/payouts $2,451.97 and cost $64.88. Revenue/payout differences are consistent with sub-cent aggregate versus per-call cent rounding; record-level identity/amount verification is still required. The cost difference is $15.84 and source-derived net is $433.22, versus Loop $449.06. Do not call this reconciled or assume faster reads remove known-cost conflicts. Live-day cost corrections need explicit reviewed source evidence; the existing completed-day correction procedure remains unchanged.
