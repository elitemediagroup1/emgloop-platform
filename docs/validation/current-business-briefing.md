# Current business briefing

## What was verified

Matt’s October 15 Home capture has current 475-call KPIs beside a four-hour-old rule briefing containing a 356-call JSON snapshot. The original renderer unconditionally preferred the stored briefing and joined every limitation inline. The rule composer cut each artifact at 240 characters, including structured JSON. Calendar model evidence supplied event times without an observation instant or phase. CallGrid supplied payout/cost details only when every financial field was present.

AWS read-only verification on October 15 found the production worker actively reading CallGrid every 30 seconds, but no `LOOP_INTELLIGENCE_BRIEFINGS` setting and no `loop.briefing.compose` task. Successful infrastructure deployment did not enable this independent stage. No keys were read and no production configuration or business records were changed by this work.

## Implemented behavior

- Home and Headlines share a read-only current-briefing loader. A stored summary needs the same current authorized evidence fingerprint, a nonfuture generation time and an age below 15 minutes. A mismatch uses the pure deterministic rule over currently eligible artifacts and labels the AI summary as awaiting refresh. It invokes no model and persists nothing during rendering. Source-read failure still returns the existing unavailable state; it never falls back to unchecked old text.
- The loader rechecks permissions, source freshness and unresolved refresh work through the existing gathering path. It adds database reads, including the existing current-day and prior-month aggregates, to each page load. Home’s visible refresh already runs every 15 seconds; monitor query latency. No source API polling is added to rendering.
- Structured snapshots retain their complete chat/model evidence. Their separate human-readable fallback states stored call counts and reported revenue. Fallbacks select complete sentences, preserve decimal amounts and partial-coverage disclosure, and never print JSON. Today’s snapshot leads other watch lines. Rolling-week CallGrid/Campaigns readings are labeled as such. Limitations remain available behind collapsed native details, and current rule projections explicitly disclose that they are not model summaries.
- The briefing template changes to version 5: distinguish each artifact’s period, prefer today’s snapshot for today’s totals, and avoid unsupported routing/capacity explanations. Numerical grounding and all existing validators remain. Unchanged stored briefings are re-evaluated after the same 15-minute age limit. Model calls remain subject to existing daily budgets; this patch does not guarantee a model summary after every call.
- Calendar producer version 2 supplies observation time, today boundaries, remaining counts and each event’s ENDED/IN_PROGRESS/AHEAD phase. A phase transition changes its fingerprint even when the event itself is unchanged. CallGrid/Campaigns producer version 4 includes independent payout and cost coverage for the domain reader, without presenting stored totals as source reconciliation.
- Worker briefing processing has a 45-second cancellation signal and safe activation/rejection logs. Producer or situation discovery errors no longer skip the independent briefing stage. Existing gateway timeouts, activation, policies and budget limits remain.

## Commissioning after merge

1. Deploy the web change through the existing Netlify Git deployment.
2. In GitHub’s `connections-production` environment, set `CONNECTIONS_PRODUCTION_INTELLIGENCE_BRIEFINGS` to `on`. Append `loop.briefing.compose` to the existing `CONNECTIONS_PRODUCTION_AI_TASKS`; preserve every existing task, provider and organization setting. No new API key is required. Use staging first where configured.
3. Run the existing connections infrastructure **diff**, inspect the changes, then **deploy**. A Netlify build does not deploy the worker.
4. Verify `intelligence_briefing_config` reports `enabled:true` and `modelTaskEnabled:true`. Check `intelligence_pass` briefing outcomes and `intelligence_briefing_stage` reason codes. A RULE outcome is not MODEL success. Investigate any gateway policy, validation, cancellation or budget refusal rather than raising limits blindly.
5. On Home and Headlines, confirm a recent model-composed briefing uses current periods and call totals. Check Mail against the same viewer’s current reply lanes and Calendar after an event ends. During refresh/failure, the surface must visibly identify recorded facts and retain coverage details instead of presenting old prose as current.

No financial field is changed. The independently verified $15.84 CallGrid/Loop cost gap still needs source-ID-level reviewed correction. Complete mailbox history, all-domain completeness, instant model generation and full CallGrid parity are not established by this patch. CallGrid/Kaliper MCP installation inside Loop remains separate.

## Validation

Database suite: 1,828 passed, 215 PostgreSQL integration tests skipped because no test database is configured. Worker suite: 143 passed, 12 integration tests skipped. Focused Home/Headlines/current-briefing web suites: 58 passed. Total unique suite results: 2,029 passed, 227 skipped. Database, worker and web typechecks passed. Final production web build passed. The Next lint command still stops at the pre-existing missing-ESLint-configuration setup prompt; lint did not pass. No production database or model was invoked by the regression tests.

## Follow-up: exact input packing after activation

At 22:09 Eastern on October 15, production worker revision 22 verified both activation settings, three domain MODEL_READ outcomes and three briefing RULE outcomes with `LOOP:INPUT_LIMIT_ABOVE_POLICY`. The old 24,000-character evidence budget is not the gateway budget: the gateway estimates roughly one token per two characters, plus overhead, instructions and schema, against a 10,000-token loop-briefing cap.

The follow-up uses that exact estimator over the actual context and rendered instructions/schema, targeting at most 9,500 tokens to reserve repair space. It drops whole oversized artifacts first, otherwise the historical baseline before today’s snapshot, then trailing artifacts. No JSON or sentence is truncated. Every omitted domain is disclosed once as a CONTEXT_LIMIT gap; the model cannot infer that omitted work is quiet. Remaining evidence and original gaps are preserved, and repeated fitting is stable. The existing artifact-count bound remains. Model generation and read-only current-briefing checks use the same selection and fingerprint. The shared chat overview gather is bounded by this selection too; Ask Loop retains its separate final packing/history cap.

After merging the follow-up, redeploy the connections worker with the already-correct settings. Verify a COMPOSED briefing outcome, successful invocation provenance and current coherent Home/Headlines prose. A green deploy or successful domain reading alone does not establish briefing success. Existing policy/budget refusals remain enforced, and lower operator limits may still refuse input. No key, permission, budget ceiling, migration or financial-record change is required.

Follow-up validation: 1,830 database tests passed, 215 PostgreSQL tests skipped; focused Home/Headlines web suites 58 passed. Database typecheck and production web build passed. Web typecheck passed. Next lint again stopped at the existing missing-configuration prompt. The new regression demonstrates the original refusal, verifies the exact admitted size including schema/instructions, verifies repair headroom, preserves current evidence beside an oversized artifact, and asserts omission disclosure/stable refitting.
