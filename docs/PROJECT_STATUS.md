Warning: truncated output (original token count: 56131)
Total output lines: 2793

## Meta creator analytics — expiry response fallback in review (2026-11-06)

PR #446 is merged at `c0e169a87a495ef10668e45620e046a7513b4825`. Meta app `1142800971568300` exists under verified `elite_media_group_`; Facebook Login for Business configuration `1161040433565608` uses a user token and Matt reports all five read-only permissions selected. Matt reports the production migration workflow green and the app secret privately saved. App ID, configuration ID and the generated sealing key were configured through Netlify. Production deploy `6aee1f6443f497161aca78da` is ready.

The 21:50 UTC OAuth callback failure was diagnosed after PR #447: Meta's long-lived token exchange returned an access token without `expires_in`, so Loop correctly refused to save it. PR #448 adds a fallback to Meta's token debugger and validates validity, app ID, Facebook user ID and a future expiry before accepting that token. It never guesses a 60-day lifetime. Focused provider tests and the production web build pass; web typecheck and web test suites are being rerun after serializing the build/type generation. No new OAuth attempt should be made until PR #448 is merged and deployed. No real analytics or AI reading is verified. Worker deployment, `creator.analytics.reading` activation, App Review and live data/analysis acceptance remain unverified. See `docs/runbooks/meta-creator-analytics.md`.

# EMG Loop — Project Status (where we left off)

## Public product website and TikTok review — November 6, 2026

The public website branch replaces the signed-out root login redirect with a developed
product overview, adds static `/creator-hub` and `/integrations/tiktok` descriptions,
and exposes existing Privacy Policy and Terms links in the public footer. The login page
links back to the product overview. Signed-in root visitors still go to `/app`; safe
requested sign-in destinations and all private guards are preserved. No private creator
records, real creator images, credentials, OAuth changes or new data access are published.
The homepage workspace illustration is explicitly labeled and contains no live metrics.

The TikTok guide documents the actual read-only scope/field behavior, consent, Profile
refresh, disconnect and production approval pending. Automatic social onboarding media
import remains unimplemented. Website review deployment does not establish TikTok API
approval: Matt must provide a dedicated creator test login privately and demonstrate the
actual sandbox flow, then resubmit. See `docs/runbooks/tiktok-review-resubmission.md`.
No migration, environment variable or spending change is needed for this website release.

## Creator Hub design — live November 6, 2026

PR #444 is merged and production deployed at `e2462cf9ce91df8b2a4543aa75e7070ce99d40c9`
(Netlify `6aed36b84029a5562bdf2d11`). Trevon's authorized production login verified the
editorial layout, five loaded real Instagram/YouTube assets, 93 Outreach, 11 Conversations,
0 Active Deals and 5 earlier/paused brands. BassForecast expands to a consolidated summary,
next action and three historical updates. Refresh updates returned a successful request;
fresh AI completion and the full historical evidence inventory remain unverified.
The images are a reviewed curated selection with provenance, not an automatic social feed.

## Headlines — #405 live; feed diagnostics and length repair follow-up (2026-10-19)

#405 is merged as `4955ba1d90c5ae0a4113d4a01af7251a45a22ec9` and Netlify production published that commit on October 17. Signed-in Home and full Headlines verification on October 19 showed an actual conditional INSIGHT connecting Chats and CallGrid, with the reading's own timestamp. This verifies connected rendering, not a proven causal link or complete source coverage. Public-news storage is operating: production logs repeatedly recorded four refreshed feeds and one failure. The prior count-only event cannot identify the failed source or distinguish download from persistence failure. All five fixed feeds parsed successfully from the development environment; the production failure's cause remains unknown.

Production worker logs over the inspected two-hour window recorded 18 COMPOSED briefings across the served principals, two RULE results (one ANSWER_TOO_LONG, one TASK_CIRCUIT_OPEN), three REUSED and 136 DEFERRED. These are not 18 Matt-specific headlines. Branch `fix/headlines-feed-and-repair-recovery` adds fixed source/error/phase/count diagnostics, distinguishing publisher reads and storage errors without logging response bodies, URLs, credentials or exception prose. Metadata writes use an explicit bounded 20-second atomic transaction for up to 40 articles; this addresses the default five-second limit as a possible failure mode, not a diagnosed production cause.

Briefing template 8 retains the same contract and single governed repair. Rejected overlength output supplies at most eight fixed field/index/count measurements to that repair, with shorter target prose. Rejected prose stays out of storage and logs. Unvalidated output remains hidden; provider routing, activation, budgets and the fifteen-minute cadence are unchanged. TASK_CIRCUIT_OPEN is observed but not bypassed or claimed resolved.

Headlines still uses authorized current internal readings and bounded public title/date/link metadata from FTC, Google Ads & Commerce, YouTube, Digiday and Search Engine Land. Two distinct supplied citations, including internal evidence, and conditional wording are required for INSIGHT. The catalog is not complete outside-world or LinkedIn coverage. Creator Hub needs actual records; stale or omitted sources remain gaps. Historical no-route attempts cannot become today's retainer growth; #405 preserves provider identity/event dates and weekly totals. Source financial parity remains separate and unverified by these changes.

The follow-up requires reviewed merge, web and worker deployments, then per-source log verification and accepted current Headlines. No migration, API key, policy or budget change is required. No live configuration or production data was changed during this follow-up. See `docs/runbooks/business-headlines.md` for scope and commissioning.

## Current business briefing — #401 deployed; generation and coverage gaps remain (2026-10-16)

#400 is on main and the connections deployment was verified in production account 080891698678: at 10:08 Eastern the worker recorded COMPOSED:3, then at 10:09 DEFERRED:3 / REFRESH_INTERVAL. This proves model composition and pacing, not the web presentation. Matt's 10:29 Home paste still shows recorded-facts fallback because every incoming call invalidates the exact fingerprint while the model waits fifteen minutes.

#401 is merged and Netlify production commit 2874c7f was published at 11:37 Eastern. A direct signed-in Home review at 11:53 displayed an AI briefing as of 11:47 alongside newer live KPIs, verifying historical display in that instance. It separates current facts from recent AI analysis. Changed/stale summaries still cannot lead as CURRENT. For up to thirty minutes on the same local date, the UI may show a separate AI briefing explicitly stamped with its actual reading time, with current recorded facts collapsed beneath it. Every original context reference and every line citation must remain in this viewer's authorized source history. Stale readings remain historical only while their source is connected; Mail content consent is rechecked separately. If any earlier context disappears, the entire older answer is hidden, including its headline and limitations; citation validation cannot establish line-by-line private information flow. Missing, future, previous-day, expired or entirely unreferenceable model output is hidden. A person/date/schema/composer-scoped repository query can recover the last MODEL brief if a later RULE attempt was written. Home preview remains capped at three observations. No model calls, writes, budget/cadence changes, migration, dependency or worker configuration changes are added by this display patch.

Mail is excluded as stale in the supplied page; a tile's current rule counts do not establish a current Mail AI reading. Do not remove the stale guard. AWS Core was reconnected to production account 080891698678 at 11:45. Worker logs at 11:31 show COMPOSED:1, RULE:2 with UNSUPPORTED_NUMBER_IN_TEXT and TASK_CIRCUIT_OPEN; the current exact rejected text is not stored. The live status page at 11:40 shows Mail 692 pending/97 held, no mail.domain.reading model invocation in 24 hours, and 27/73 rejected briefing calls. Mail rejection/coverage diagnosis remains open. The already-verified 10:08 production results remain valid historical evidence. The broader day/timezone issue and CallGrid source cost reconciliation remain separate.

After merge: deploy the web via Netlify, then verify the as-of AI reading beside live KPIs and current recorded facts. No connections-infra-deploy is needed for the display change. A green build is not proof of complete Mail coverage or source parity. Validation: 83 focused web and 20 database tests pass; database and web app/test typechecks and diff check pass. Production build compiles, checks types and generates 96 pages, but fails with the existing `.next/export` ENOTEMPTY cleanup error. Lint is blocked by missing existing ESLint configuration. Require green Netlify preview/CI before merge; live UI remains unverified. See `docs/validation/briefing-as-of-summary.md`.

## Ask Loop evidence packing follow-up — October 15, 2026

PRs #393 and #394 are merged and deployed. A live Mail question returned INPUT_LIMIT_ABOVE_POLICY; the precise production artifact size was not exposed. Local regression reproduces how one oversized Mail overview evicts readable messages and then prevents invocation. Chat now prioritizes bounded Mail conversation evidence, removes individually oversized artifacts before other sources, records omissions, and reserves room for repair instructions under the unchanged 12,000-token cap. This follow-up is not deployed yet. Headlines presentation is live, but Matt’s daily briefing was still absent at verification. CallGrid source financial parity remains unverified.

The living "current state" per workstream, so any session (or Matt) can resume without
losing the thread. **One current-state block per workstream — overwrite it, don't append.**
Read this at the start of a session; update it at the end of a work batch. History lives
in git, not here.

_Last updated: 2026-10-08 (CRM People command center built, PRs open, nothing commissioned; brand-outreach import APPLY done per Matt — see the two CRM blocks; earlier 2026-10-05: website intelligence: foundation live with 7 LIVE sites and zero events — CORS + install proven as the cause, fixes and visitor journeys in a draft PR — see its block; earlier 2026-09-30: website evidence foundation built; earlier 2026-09-26: Loop Intelligence Phases A–G built in one draft PR, nothing commissioned; #340 AI runtime corrected to MERGED/MIGRATED/DEPLOYED/VERIFIED with the operating budget recorded, Anthropic production-active, OpenAI not commissioned — see the two Loop Intelligence blocks; earlier 2026-09-24: Loop Home briefing built, draft PR in review; Creator Hub commissioned on staging — #323/#324/#325 merged, infra + migration + seed done, staging fast-forwarded and verified; production schema untouched — see the Creator Hub block; earlier: Intelligence & Memory Foundation commissioned — #305/#306 on main, migration 42 applied, completion PR in review; Google onboarding: #302/#303 merged, Gmail cycle not yet on, one-derivation PR in review; production at migration 41; Gmail GM-1..GM-3 in review as #295/#296/#297; AI runtime #266–#271 merged, switched off; B0–B6 merged incl. #284, B7 pre-deployment #285 merged; AWS staging not bootstrapped, nothing deployed; Google Workspace connection (Private V1) merged as #286 and migration 37 applied in production; Daily Loop / Employee Intelligence architecture merged as #287, DL-0..DL-3 merged with migrations 38 and 39 applied and production verified, DL-4 (Your Day) merged as #293, DL-5 (the automated Calendar cycle) in review; see the Foundation handoff and Google Workspace blocks)._

---

## Proactive intelligence, Ask Loop and historical retrieval — BUILT, NOT COMMISSIONED (2026-10-15)

Current follow-up `fix/proactive-briefing-delivery`: #392 is live; #393 is the separate pending Mail record-provider correction. Live Home showed incoming CallGrid calls with only 85% financial-field coverage. Headlines showed one unmeasurable roofing objective and no stored business briefing for Matt. This is not proof of a failed CallGrid connection or successful source reconciliation. The new patch namespaces stored Loop-brief queries so a newer non-Loop daily record cannot hide the summary; supplies the validator's omitted line/limitation limits; permits one validated repair from original evidence; records safe rejection codes on rule fallbacks; bounds provider work with cancellation; prioritizes missing daily recipients while preserving fair rotation; and runs independent briefing work even after other scheduled stages fail. Home Headlines displays the same stored business summary above clearly scoped objective signals. No financial fields are overwritten and no warning is suppressed. The latest production proactive invocation remains rejected, not proven fixed by local tests. See `docs/validation/proactive-briefing-delivery.md`.

Branch `feat/proactive-intelligence-chat`, based on main `85178e1`, extends the existing gateway: Anthropic handles proactive readings/briefings and situation synthesis; OpenAI handles the new read-only `loop.question.answer` task and independently verifies Anthropic-authored situations. Floating Ask Loop lives in the shared shell, answers with citations/gaps, takes identity only from the session and has no write tools or persistent raw conversation store. Domain explanations now allow 900 characters while signals remain bounded and grounded.

The existing Mail schedule gains an independently drained overview stage and bounded web synthesis/briefing continuation. Exact producer-target queue claims prevent overview/thread mismatch; thread-derived overview keys no longer collide; reply counts use the same corrected dashboard classifier. Source/queue freshness prevents old homepage readings from overriding live counts. Headlines adds the person's stored briefing without changing objective measurement authority. Daily stored-call snapshots, named campaign economics, net-cost coverage and a prior-month historical baseline supply useful context. Historical question totals are aggregated inside the existing Neon database; no new financial store, schema, raw-message retention or model-training path was introduced.

PRs #388–#391 are merged; #391 deployed at 2026-10-15T19:02:37Z. After Matt added OpenAI billing, live general-update and CallGrid follow-up questions answered successfully. A Mail follow-up was rejected and Matt separately reported an interrupted Mail answer. Billing presence and green deployment do not establish complete source retrieval or working proactive summaries.

Branch `fix/ask-loop-mail-and-deadlines` adds one interactive source path using existing domain gather/rule readers with nested model stages disabled: CallGrid, campaigns, intake, CRM, creators, website, organization/personal work and own calendar. Domain permissions and active membership are checked before and after gathering; snapshots explicitly retain partial stored-source coverage. Requested Mail content uses the existing own-Gmail read-through under the recorded governance decision and active personal authorization, rechecked after reading. It is transient and bounded to three recent conversations and three trimmed messages each; it cannot claim a complete inbox review or save importance flags. Chats still use existing authorized current digests, not arbitrary message search. Chat retains its cited answer contract, bounded history and actual input fitting. A shared 45-second answer deadline aborts subsequent provider/repair attempts; one validation repair uses original evidence and the same governed runtime. Unvalidated answers remain hidden and expose only bounded rejection codes. PR #392 merged as `7b967b3` and deployed at 2026-10-15T20:13:36Z. Live Mail and general-update questions answered; the general update covered CallGrid, CRM, calendar and website while explicitly reporting absent Work/Creator readings. The Mail answer still lacked today-only message content. Inspection found that the new thread query used the content-authorization provider GMAIL, but WorkThread stores provider GOOGLE. Branch `fix/ask-loop-mail-record-provider` corrects only that record query, keeping GMAIL consent checks intact. The regression fixture now models actual stored provider vocabulary, fails before the correction and passes after it. A proactive briefing invocation was recorded but rejected OUTPUT_INVALID; proactive success is not established. Proactive MODEL briefings, exhaustive record search and production historical backfill remain unverified or unbuilt; no model-training path was added. See `docs/validation/proactive-intelligence-chat.md` for commissioning and limits.

## CallGrid continuous API reads — prepared, not activated (2026-10-15)

Branch `feat/callgrid-continuous-api`, based on merged #396, adds an explicitly activated API reader inside the existing Fargate connections worker. It starts immediately and checks every 30 seconds, uses the same canonical frontier poll/checkpoint/revision path and 15-minute overlap, and removes the planner’s two-minute safety delay only for this path. It never overlaps its own active read, backs off on unsuccessful coverage, checks the bound organization, records coverage lag and duration without raw payloads/credentials, and waits for the active poll on shutdown. Changed ingested calls request the existing governed intelligence pass asynchronously. Requests arriving during a running pass coalesce into a follow-up pass; model latency does not hold ingestion. Home and read-only CallGrid report views also refresh their stored server view every 15 seconds while visible, pausing for input/chat. Overview/Intelligence are excluded because their existing loader records detections; this patch does not automatically repeat that write path. Existing AI budgets, activation and validation still apply; 30 seconds is a scheduling target, not a source-to-screen SLA or instant-summary guarantee.

Deployment wiring is off by default. For the intended stage, put the existing CallGrid credential in the operator-provided AWS secret `loop/connections/<stage>/callgrid`, JSON field `api_key`, and set the GitHub environment variable `CONNECTIONS_<STAGE>_CALLGRID_ORGANIZATION` to the approved organization slug. The existing connections-infra-deploy workflow passes it identically to synth/diff/deploy. No new worker/service, public endpoint, schema, dependency, browser secret access or live AWS change. Existing hourly deep rereads and GitHub recovery remain a fallback. Deploy/commission staging first, then review production diff and deploy. API request timeouts and CallGrid’s documented RateLimit-Reset fallback protect continuous reads. See `docs/runbooks/callgrid-continuous-api.md`.

#396 is merged and deployed (`cd7fbf6`). Live October 15 20:27 Eastern Loop Money showed 472 calls, 148 monetized, revenue $2,965.91, payouts $2,451.97, telco $64.80, net $449.14; daily missing-field withholding was gone. Recovery was proven only through 19:50 and Home’s fallback briefing remained three hours old. Exact CallGrid source parity is not certified. October 14’s known-cost $7.12 discrepancy still requires reviewed correction; unknown source amounts stay unknown. Historical periods outside routine overlap need reviewed recovery.

CallGrid MCP is now …46131 tokens truncated…set as
`CONNECTIONS_PRODUCTION_ACCOUNT_ID`; the CDK app and both workflows refuse the management and staging
ids by name.

**Draft PR #328 (`feat/connections-production-path`, off main `771ca58`) — PR 1 of the commissioning:**
- `infra/connections` production stage: `targetFor(stage, context)`, `loop/connections/<stage>/…`
  secret names, production media origin `https://app.emgloop.com`, cost budget + worker-down alarm +
  SNS (production fails synth without an alert address), `loop:stage` tags, access templates with one
  `Stage` parameter (defaults render exactly the deployed staging identities), `connections-infra-deploy`
  with a `stage` input, environment `connections-<stage>`, confirm `deploy loop-connections-<stage>`
  as a normalized shell gate, resolve-by-stage guards. CI synthesizes both stages offline.
- Read-only production probe `read-telegram-state` (workflow + `npm run read:telegram-state`): states,
  HELD flags, failure classes, counts, 7-day AI ledger — never a label, key, cursor, id or address.
- Retention/revocation fix: new system-only outcome `REVOKED`; revoke withdraws derived Telegram items
  in the same transaction (close + minimize to provenance); worker purge deletes derived items for
  connections disconnected ≥ 30 days; offboarding (`disableMember`/`removeMember`) now disconnects
  Telegram and revokes content consent in the same transaction — it previously left a departed
  member's sealed session READY. **Migration `20261001000000_work_item_outcome_revoked`** (additive
  CHECK restatement) is required before the revoke path runs where derived items exist. **Staging:
  dispatch `connections-migrate-staging` FIRST, then fast-forward `staging`** (the migration is
  backward-compatible; code before migration makes a revoke by anyone holding an open derived item roll
  back, so consent could not be withdrawn). Production's dispatch carries 43–49 in one run.
- Runbook `docs/runbooks/connections-aws-production.md` (Parts 1–10).
- Validated: infra 56/56 + synth both stages + actionlint; ops 649; shared 1383; database 1581
  (+67 Postgres-only skipped) and 1657 with Postgres; worker 79; web 720; typecheck clean; web build
  passes.

**Production first deploy (2026-09-24) ROLLED BACK:** migrations 43–49 applied and the CDK diff was clean,
then `connections-infra-deploy` `deploy` failed — "Essential container in task exited", worker exit
code 1, circuit breaker, `ROLLBACK_COMPLETE`, and no CloudWatch log (the log group was DESTROY-policy
and went with the stack). Diagnosis (draft PR #332): the code boots on `main` with correctly shaped
values (reproduced locally, sweeps run), so the exit is the worker's fail-closed `NotConfigured` on
an operator-entered value shape — `connection-key` not 32 bytes of base64, or `telegram.api_id` not
a positive integer. The PR retains both log groups and makes the fatal line name the setting; the
runbook's Part 7 gained "If the first deploy rolls back": shape checks that print nothing secret,
force-delete of the two retained generated secrets (or the retry fails on "already exists"),
stack removal, retry.

**Next (ordered; Matt, consoles):** #328 merged; (1)–(3) DONE 2026-09-24 (account, OIDC, access
stacks, environment + variables, secrets `telegram`/`connection-key`/`database-url`; the `ai` secret
waits for Part 9) → merge draft **#330** (`Deploy Prisma Migrations` gated by `connections-production`,
OIDC migrate role, only the production secret, `confirm: migrate loop-connections-production`, account
pinned `080891698678`) → (4) dispatch `Deploy Prisma Migrations` (43–49) → (5) `connections-infra-deploy` `stage: production`, `diff`
then `deploy`; confirm the SNS subscription (Part 7) → (6) Netlify production: `LOOP_CONNECTION_PROVIDERS`,
`LOOP_CONNECTIONS_WORKER_URL`, `LOOP_CONNECTIONS_WORKER_SECRET` → (7) fresh Telegram authorization on
production (Part 8), then `read-telegram-state` → (8) AI triage on (Part 9). Claude: after each step,
run the probe and report; fixes as `fix/…` PRs.

**Chats Intelligence (PR B #338 + PR C #339) -- MERGED; PRODUCTION COMMISSIONED 2026-09-25.** Triage task
3.0.0 / schema v4 returns obligations AND a minimized conversation reading (the person's CHATS digest) in
one call; the digest-only hydration sweep initializes people whose backfill completed earlier (migration
`20261004000000` applied in production). Production Connections AI runs `telegram.content.triage` on
Anthropic for `demo-org-0001`. Watch `chats_hydration` logs and `read-telegram-state`.

**Follow-ups recorded in #328.** DONE on `fix/detect-consent-recheck` (draft PR #331; the runbook's
Part 9 gate, must merge before step 8): `WorkItemRepository.detect` re-checks content consent inside its
own transaction, so an in-flight sweep can no longer write a derived item after a revoke or offboarding.
**Not done:** Telegram-side logout on offboarding (documented, not faked); `source_baseline_checkpoints`
not revoked at offboarding; a REVOKED item re-detected after fresh consent does not reopen (detect
refreshes its title/evidence and appends REDETECTED without reopening — pinned by
`work-item-detect-consent.postgres.test.ts`); `/app/connections` shows only `contentAuthorized` (stuck
cursors visible only via the probe and worker logs).

## Loop Intelligence — PR 1 AI runtime (#340) — MERGED · MIGRATED · WORKER DEPLOYED · RUNTIME VERIFIED

**Corrected 2026-09-26.** This block previously read "IN REVIEW (draft PR)". That was stale. #340 is merged
(main `d70f737`). Migration `20261005000000_ai_runtime_capacity` is applied in production, the connections
worker is redeployed on it, and the runtime has been verified in production.

- **The operating budget is recorded:** `operating.initial.1` v1. Organization $20/day, emergency ceiling
  $25, lanes FORWARD $8 / SYNTHESIS $6 / INTERACTIVE $2.50 / BACKGROUND $2 with a 60-call cap.
- **Anthropic is production-active.** It is the only provider. `telegram.content.triage` is the only
  production task.
- **OpenAI is NOT commissioned.** That needs a terms decision, `record-ai-provider-policy` openai, the key
  in the stage AI secret, and `CONNECTIONS_<STAGE>_AI_PROVIDERS=anthropic,openai`.

Blueprint: https://claude.ai/artifact/VZuKzXAmCpc2WZsQR32gDS

## Telegram triage reliability — IN REVIEW (draft PR, branch `fix/telegram-triage-reliability`, off main `bb2d0f4`)

**Production (run 36652525469, 2026-09-30):** `telegram.content.triage` made 69 calls in a day, the class
cap: 15 answered, 32 rejected (31 ANSWER_TOO_LONG), 22 failed (21 timeouts).
- **Cause 1:** one FAILED conversation made the forward sweep return and hold the cursor, so every
  earlier window was re-sent each 10-minute cycle and every later one starved.
- **Cause 2:** template v6 never stated the `limitations` bounds and asked for detail with no headroom.

**Fixed in the PR:**
- A failed window is isolated; the sweep continues.
- An exact window already judged is never re-sent (the ledger's content-free manifest hash plus the
  stored reading's window fingerprint).
- A failed window backs off 3 hours, at most 4 attempts, then is abandoned and counted.
- Template v7 states every limit with a target below it.
- Rejections name the overflowing field (`TOO_LONG_<FIELD>`).
- Read Intelligence State prints `AI_TASK_WINDOWS`, `AI_TASK_LATENCY` and `CONTENT_HOLD`.
- Unchanged: the privacy architecture (no message text persisted), the timeout (20 s, pending latency
  data), no CHATS rollup, no Situation or Briefing change.

**Next (Matt):**
1. Optional: dispatch Read Intelligence State on the branch to read the latency and repeats before merging.
2. Review and merge. No migration.
3. Redeploy the worker.
4. Re-read after a day: `repeatedWindows` should be near zero, and ANSWER_TOO_LONG should drop, with
   `TOO_LONG_<FIELD>` naming whatever remains.
5. Then decide the timeout from `AI_TASK_LATENCY`.

## Loop Intelligence — Anthropic commissioning across domain readings — IN REVIEW (draft PR, branch `fix/intelligence-anthropic-commissioning`, off main `20fc667`)

**Root cause.** Anthropic was not switched off. A blank `CONNECTIONS_PRODUCTION_AI_PROVIDERS` means the
default, `anthropic`: the production synth on 2026-09-29 sets `LOOP_AI_PROVIDERS=anthropic` and references
`anthropic_api_key`. What was actually wrong:
- **Unprovable.** No record said whether a reading was the model's or why not; the stage code lived only in
  CloudWatch logs.
- **Unbounded spend.** A failing provider was re-asked every 15-minute pass. CallGrid and Campaigns
  re-asked about 24 times a day each (an hour key over a sliding window), enough to exhaust the BACKGROUND lane
  (60 calls) that Telegram hydration shares.
- **Contradictory prompt.** Template v2 told the model "owedBy ... otherwise UNKNOWN", which the contract
  refuses.

**Fixed in the PR:**
- `modelStage` and `readingIdentity` are stored on digest provenance.
- Read Intelligence State shows `INTELLIGENCE_READING`, `AI_LEDGER` and `AI_LEDGER_REJECTION`: digests
  joined to `ai_invocations`, codes only.
- A 3-hour failure backoff and a 6-hour model-read interval for organization readings.
- A merge guard.
- Template v3: the contract stated, plus a concision and honest-silence standard.

**Production facts (run logs):**
- Anthropic policy ACTIVE up to COMMUNICATION_CONTENT; OpenAI NONE.
- `operating.initial.1` is recorded (BACKGROUND $2 and 60 calls, breaker 10 an hour).
- The acting operator is named.
- CRM has 0 established Parties, so it has no reading.
- **`situation.synthesis` and `situation.verify` are ALREADY in `CONNECTIONS_PRODUCTION_AI_TASKS`, with
  `INTELLIGENCE_SITUATIONS=organization`.** Synthesis would run by itself the moment a source-independent
  cluster appears (0 today).

**Next (Matt):**
1. Review and merge. No migration.
2. Optional but advised: remove `situation.synthesis,situation.verify` from `CONNECTIONS_PRODUCTION_AI_TASKS`
   until Situations are commissioned deliberately.
3. Redeploy the worker (Connections infra deploy, production). Template v3 is a new reading identity, so every
   domain with evidence makes one model read on the next pass.
4. After about 20 minutes, dispatch Read Intelligence State and read the `INTELLIGENCE_READING` lines.

## Loop Intelligence — Situation entity-link projector + independent sources — IN REVIEW (draft PR, branch `feat/situation-entity-projector`, off main `9d8b72b`)

**Starting point (production, 2026-09-29):**
- #350 (intake eligibility) is merged, and `pipeline.domain@2` is commissioned.
- `PIPELINE_INTAKE eligible=1 basisWebLead=1 basisHumanWork=0 working=0`.
- The 24,579 CallGrid caller rows are not intake.
- Situations stop at `INSUFFICIENT_SIGNAL_DOMAINS` with `modelCalls=0`, and the connectivity probe reads 0.

**Built:**
- **Projection.** `GovernedEntityLinkProjector` projects three read-time, organization-scoped classes, with
  nothing persisted and no migration:
  - `CUSTOMER_PARTY`: an active Party link to an established Party of the same organization;
  - `CREATOR_PARTY`: a CreatorProfile's own Party;
  - `WORK_ORIGIN`: a person's promotion from an ORGANIZATION digest signal.

  Every other shape is rejected with a code.
- **Independence.** Independence rests on the source registry's lineage: at least 2 distinct registered
  `sourceId`s. CallGrid + Campaigns is one source. Only independent clusters reach synthesis
  (`sameSourceOnly` is counted in the pass report).
- **Pipeline** (`pipeline.domain@2` v3) names up to six stalled eligible records per status.
- **The probe** prints relationship classes with rejections, `sourceIndependentClusters`, `eliminatedSameSource`,
  composition, and CURRENT vs PROJECTOR from the real clusterer.
- **Removed:** the upper-bound estimate and the DOMAIN_SOURCE map.

**Adversarial review (2026-09-29), fixed in the PR:**
- A signal takes its digest's source only when the digest read exactly one source.
- Model `m.*` signals are out of clustering.
- A work origin links only a single-entity signal.
- Work's overdue and past-return signals each name their own instances (`work.domain` version 2).
- A projected customer must be the organization's own.
- The projection follows chains for up to 3 hops.
- A cluster's identity is its named references, never a union-find root.
- Source independence is named apart from verification (`sourceIndependent`, `sameSourceOnly`).

**Expected in production after deploy:** zero, or near zero. That is a valid answer:
- every class at `records=0 links=0` (or a few Party links whose customers aren't intake);
- `sourceIndependent=0`;
- reason still `INSUFFICIENT_SIGNAL_DOMAINS`.

**Next (Matt):**
1. Review and merge.
2. Redeploy the worker. The Pipeline and Work readings refresh once, and Work's two lateness signals name
   their own instances.
3. Run Read Intelligence State.
4. With `sourceIndependent=0`, change nothing: connectivity grows only through real work (a person linking an
   intake record to its Party, established creator Parties, promoted Work).
5. With `sourceIndependent>0` and `WOULD_SYNTHESIZE`, the next decision is whether to commission
   `situation.synthesis`. That is a separate, recorded decision.

## Loop Intelligence — Intake eligibility repair — MERGED (#350) · `pipeline.domain@2` COMMISSIONED IN PRODUCTION

**Repair:** one shared definition, `IntakeEligibilityRepository`.
- **What counts as intake:** a verified web lead, or a human operator member's explicit work (a HUMAN_AGENT
  note, an audited status change, a user Party link). An assignment alone doesn't count, and nothing is
  migrated.
- **The clock:** the latest human work; `lastSeenAt` is never read.

**Production:** 1 eligible record (an archived web lead); the 24,579 caller-only rows are excluded.

## Loop Intelligence — COMPLETE BUILD (Phases A–G) — IN REVIEW (draft PR #341, branch `feat/loop-intelligence-fabric`, off main `d70f737`) · NOTHING COMMISSIONED

**Built, in one draft PR with one commit per phase:**

- **A:** the fabric (participation contract, registries, ORGANIZATION digests, entity links, refresh queue,
  producer loop, domain-reading.v1).
- **B:** Chats v5 (owedBy, typed signals, grounded parties, portable triage schema v5, what-needs-whom
  groups, handled / snooze / dismiss).
- **C:** Promote to Work.
- **D:** Mail intelligence, gated closed by the counterparty-consent decision.
- **E:** Calendar, CallGrid, Campaigns, Intake, People, Creators, Work and Website producers. Readings on
  every domain page and on Home. A worker host, a Mail pass route and a shipped-off workflow.
- **F:** connected situations held as Cases: deterministic clustering, cited synthesis, OTHER_THAN_SUBJECT
  verification, and private situations that belong to one person alone.
- **G:** the Loop Briefing, stored in `work_briefs`, reused when unchanged, deterministic when the model is
  off.
- **Plus** connections-infra plumbing for the worker's intelligence settings, unset by default.

**Migrations, not applied anywhere.** None rewrites a row. Numbers 1 and 4 drop and replace constraints
(backward-compatible); 2, 3 and 5 are additive only:

1. `20261006000000_intelligence_org_digests`
2. `20261006000001_entity_links`
3. `20261006000002_intelligence_refresh_queue`
4. `20261007000000_promote_to_work`
5. `20261008000000_case_private_scopes`

**Routing and budget:** routing `routing.2026-09-26.12`, budget `budget.2026-09-26.6`. Work retention is
`.3`: a Loop Briefing is kept 90 days (the approved decision), and the worker purges older ones.

**Review fixes (2026-09-26, same PR):**

- Situations and the Briefing use only legitimately current intelligence (`digestSynthesisEligibility`).
  Partial readings keep their limitation, and no absence is claimed without full coverage.
- Briefing retention is 90 days.
- Promote to Work allows many links per origin with idempotent submissions, and private situations are
  promotable by their owner.
- Migration wording is exact.
- **Second review (same day):**
  - Loop-record readings are out of synthesis while refresh work is unresolved. NO_EVIDENCE or HELD marks
    them STALE; an unchanged refresh re-affirms them.
  - The Briefing has an explicit expected-coverage set: a missing reading is a gap, never quiet.
- **Third review:**
  - The stale transition fails closed: the barrier is removed only after it succeeds.
  - HELD cleanup is transactional.
  - The refresh lookup queries exact targets, with no cap.
- **Fourth review:** HELD refresh requests are purged by the worker's existing 6-hourly retention sweep after
  the governed 7-day window. This runs without any intelligence feature switched on, and does nothing before
  the queue's migration.

**New tasks, all inactive:** mail.content.triage; eight `*.domain.reading` tasks (mail, calendar, callgrid,
campaigns, pipeline, crm, creators, work, website); situation.synthesis[.private];
situation.verify[.private]; loop.briefing.compose. `telegram.content.triage` moves to 4.0.0 (schema v5).

**Next (Matt):**

1. Review.
2. Merge.
3. Run `docs/runbooks/loop-intelligence-commissioning.md` section A on staging:
   - migrations 1–5;
   - redeploy the worker, which moves triage to v5;
   - read back.
4. Then section B, feature by feature.
5. OpenAI is section C. Mail is section D, which stays blocked on the counterparty-consent decision
   (UNRESOLVED).

## Working agreement
**One branch per work batch.** After a PR merges, cut a fresh branch off freshly-merged
`main` for the next objective — never keep committing to a merged branch (it strands work
with no open PR). Always open a draft PR and report its URL; Matt merges.

## Website intelligence — FOUNDATION LIVE (#354, #356 merged; migration applied) · VISITOR JOURNEYS + DELIVERY FIX IN REVIEW (draft PR, branch `feat/website-visitor-journeys`, off main `211cd07`)

**Production (verified from workflow run logs, 2026-10-05):**
- The 17-domain portfolio is registered to `servicesinmycity-demo`.
- Seven sites are LIVE + ENABLED (commission-live-sites run 37354885411: commissioned=6, unchanged=1): servicesinmycity, consumersupporthelp, marriageinmycity, careinmycity, petsinmycity, gamedayinmycity, homesinmycity.
- Read Intelligence State run 37356924945 shows **zero website events, ever** (`newest=-`, `coverage=GAP_NO_EVENTS`).

**Why nothing arrives, proven:**
1. The webhook answered the tracker's CORS preflight with no Access-Control-Allow-* headers, so every browser
   blocked every tracker POST. This is fixed in the PR, not deployed.
2. None of the seven sites' homepages (or their first-party scripts) contains the EMG Loop tracker.
   `homesinmycity.com` is a parked-domain lander.
3. The Website Manager's snippet generator emitted an unclosed `<script>` tag. This is fixed in the PR.

**In review (draft PR):**
- the CORS fix and the snippet fix;
- an idempotent minimizer (referrer host survives a read-back);
- per-property `WEBSITE_COLLECTION` diagnostics (FLOWING / SPARSE / NO_EVENTS / NOT_APPLICABLE);
- **Website Visitors**: anonymous visit journeys from admitted integration_events. It replaces the
  Interaction-based Live Website Feed and the hard-coded six-site list.
- **Tracker v1.1.0**:
  - a visit ends after 30 minutes of inactivity, and activity keeps it alive;
  - `page_leave` replaces `session_end`;
  - privacy-safe link/button/CTA/outbound/download clicks;
  - CORS-simple delivery that survives navigation. Before it, events before a navigation were lost.

**Next (Matt):**
1. Merge and deploy web.
2. Install the tracker on each LIVE site (runbook step 6a).
3. Run Read Intelligence State and read `WEBSITE_COLLECTION` per site.
4. Decide homesinmycity's real lifecycle (it is a parked domain, not live).

Then the GA4 connector (separate). Open from before: the raw-telemetry purge decision, and scrubbing legacy
payloads. Architecture: `docs/architecture/website-evidence.md`. Runbook: `docs/runbooks/website-evidence-commissioning.md`.

