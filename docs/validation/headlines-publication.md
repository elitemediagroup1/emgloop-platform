# Headlines publication repair

## Verified failure

Matt's Oct 16 screenshot shows the pending state, not a business headline. Main a35f346 is #403. The Headlines component explicitly passed showHeadline=false and refused the entire model reading when its lines contained only NEEDS_YOU/AHEAD. This could hide a real model headline independently of generation.

Production AWS account 080891698678, us-east-1, log group LoopConnections-production-WorkerLogsC1193B08-qF7zs5fNaxwj: the exact 2026-10-16 18:30–19:35 UTC query, restricted to intelligence_briefing_stage and non-DEFERRED outcomes, returned 12 events. Every one was RULE / LOOP:BUDGET_LANE_EXHAUSTED. No successful composition appeared in that bounded window. These are stage outcomes, not per-user attribution.

A direct signed-in Intelligence status read stamped 17:27 Eastern showed analysis $5.96 of $6, live $3.79 of $8, background $0.81 of $2, organization $10.56 of $20 and trailing 24h $12.85 of $25. A new model reservation does not fit the remaining four cents. Budget exhaustion is confirmed; title/limitation number grounding is a separate reproducible code defect, not proven to explain all production rejections. The page reported 114 briefing runs, 65 answered and 49 OUTPUT_INVALID in the last 24h. Situation tasks had no runs in seven days. Those missing connections and Mail coverage still require follow-up.

## Change

Render the actual authorized model headline, irrespective of line kind. Keep the business-line filter for supporting observations, and keep source timestamps, limitations, permissions and the rule-only pending state. No invented headline or UI-side causal inference is introduced.

Briefing template v6 explicitly asks for a concrete business development and supported associations. Number/date grounding uses the exact minimized per-source item supplied to the model; title/limitation numbers no longer disappear from validation, internal basis metadata never becomes evidence, and numbers in another artifact remain unavailable to an uncited claim. The output validators, no-causation rule and one bounded repair remain.

The optional operating.synthesis.1 preset reallocates $4 from FORWARD to SYNTHESIS. It keeps the $20 organization day, $25 emergency ceiling, $1.50 live reserve, all invocation ceilings, token caps and circuit breaker. Live AI processing has $5.50 total headroom rather than $9.50; background defers at 75% of its smaller live allocation. This is a tradeoff, not free capacity. API ingestion is not governed by these AI lanes. Nothing applies the preset on deploy.

## Activation after review and merge

1. Confirm Netlify production is ready on the merged commit.
2. Run connections-infra-deploy with diff, then deploy, for production. Both worker and web must carry template v6; a web-only deploy is insufficient.
3. In GitHub Actions → Record AI Budget, choose main, stage production, preset synthesis, settings_json empty, reason `Reallocate existing $20 daily allowance after verified synthesis lane exhaustion; preserve total and emergency caps.`, confirm `record ai-budget production`. The workflow validates, dry-runs, records with its expected version, and prints controls after. This existing workflow explicitly requires a human dispatch; the agent has not run it or written production controls.
4. Require RECORDED/UNCHANGED for operating.synthesis.1, verify $10 synthesis/$4 live with the original caps, then wait for the existing paced briefing attempt (up to 15 minutes). Do not clear the ledger, bypass a breaker or trigger repeated unbounded generation.
5. Verify an actual COMPOSED stage, successful provider invocation, current/as-of headline on Home AND Headlines, and sensible citations/periods. A green deployment or successful budget write alone is not completion. If blocked, retain the exact refusal code; do not replace it with canned insight.

Rollback budget allocation by recording preset initial through the same workflow. Existing successful output is immutable; no historical rows are rewritten.

## Validation

168 focused Home, Headlines, briefing recovery/input/scheduler, contract, capacity and operation-workflow tests pass. Web app/test, database and shared typechecks pass. Production build passes (96 pages); diff check passes. Lint exits at the pre-existing missing ESLint configuration prompt. No migration or dependency change. Corrected deployed generation and mobile visual verification remain pending.


## Production recovery and full-page reader follow-up

After #404 merged, the budget read directly showed operating.synthesis.1 version 2, recorded at 18:14 Eastern. CloudWatch at 22:17:19 UTC recorded COMPOSED:3. Home showed the 18:17 model headline and its original weekly/daily periods. The full Headlines page still displayed pending at the same verification stage.

Source review identifies a reader-boundary defect: Headlines passes AuthSession structurally, then expectedBriefingCoverage uses principal directly/spread in Prisma where filters. Email/name/role fields survive into those filters. The page catches the reader error as null. Narrow loadStoredBriefing at entry to precisely the signed organization/user pair. Test the full-session call, strict arguments to both repository and gather, and successful model rendering data. This preserves all existing permission, revocation, historical citation and freshness gates. No worker redeploy or new budget record is necessary for this follow-up. Netlify web deploy and direct full-page verification are required after review/merge.

Follow-up validation: 58 focused current-briefing/source-guard/Headlines tests, web app/test typechecks, production build (96 pages) and diff check pass. Lint exits at the existing missing ESLint configuration prompt. Production ledger subsequently showed 117 runs/68 answered/49 invalid in 24h, exactly three additional answered runs over the previous 114/65/49 reading; latest route Anthropic / claude-opus-5. This confirms generation recovery independently of green infrastructure actions. Full-page deployed verification still awaits the reader fix.
