# Proactive intelligence and Ask Loop — 2026-10-15

This change extends the existing governed runtime, producers, work_briefs and Neon call projection. It adds no database schema, provider SDK, package, raw-message archive or autonomous write tool. It is not operational merely because the PR merges.

## Responsibilities

| Task | Primary | Other provider |
| --- | --- | --- |
| Domain interpretation, situation synthesis, proactive briefing | Anthropic, existing pinned route | OpenAI availability fallback |
| `loop.question.answer` | OpenAI, existing pinned model | Anthropic availability fallback |
| Independent situation verification | A provider different from the author | Cannot verify itself |

The gateway retains activation, permissions, provider data policies, kill switches, budgets and output validation. The question route cannot supply SQL or tool calls. Organization and person always come from the signed session. User instructions are untrusted context and cannot be cited as business evidence. Unsupported numbers are rejected. No global or lane spending ceiling was increased; questions have a separate bounded class in INTERACTIVE.

## Implemented

- Floating, keyboard-accessible, non-modal Ask Loop in WorkspaceShell. Transient conversation, source labels, evidence gaps, error states, mobile layout. No localStorage or persisted raw question/answer history.
- POST `/api/intelligence/question`: authenticated, permission checked, same-origin, JSON-only, streaming input cap, bounded questions and previous questions, no-store responses and generic errors.
- GET on the same route: safe commissioning state (activation lists and credential **presence**, never values). This is configuration evidence, not proof of a provider call.
- Short domain explanations expanded from a prompt-imposed 200-character sentence to a contract-validated 900-character explanation. Signals stay at 280 characters. Evidence references, coverage and reporting windows accompany model context.
- Daily CallGrid stored-call snapshots with exact currency, campaign names, financial-field coverage and net only where all required fields are present. Prior completed month supplies historical background to proactive briefings. Stored source completeness is never inferred from the presence of rows.
- Financial and label changes now participate in the CallGrid reading fingerprint. Campaign signals identify the business campaign and selected fully covered campaign economics.
- Mail overview gets an independent queue drain. Queue claims match producer domain, scope **and subject kind**, preventing the overview-only host from claiming thread work. Thread-derived signal keys remain unique across conversations.
- Web Mail overview uses the same corrected, bounded Mail dashboard classifier for reply counts. Its coverage is partial, not a claim that every historical thread was read.
- Domain surfaces use the synthesis freshness decision, including live source state and unresolved refresh work. Stale domain prose cannot override current homepage counters.
- Headlines displays the same person's stored business briefing in addition to the objective/Case feed. These are different evidence authorities; a briefing does not turn an unmeasurable objective into a measured one.
- The existing Run Mail Intelligence workflow runs every 15 minutes, draining threads and mailbox overviews separately, then bounded organization/private situation passes and briefings. Synthesis uses the existing services/stores, at most one changed cluster per HTTP pass, and reports diagnosis codes. GitHub cron remains best effort.

## Historical data and business memory

Neon is already the durable store for Loop's source observations, canonical call projection, provider-fact revisions, relationships, work, briefings and governed knowledge. Do not introduce a second financial truth store or assume calling an API trains a model on EMG.

Question windows support explicit ISO dates/ranges, named months, last month/year, this month/year, years, and bounded long ranges. Long-period financial totals are aggregated **inside Postgres**, preserving missing-field counts, not loaded as years of raw calls into an AI prompt. Explicit year comparisons supply separate yearly snapshots. Long-period snapshots do not supply campaign breakdowns. Unsupported or ambiguous periods need a clearer date range. The financial reporting calendar is the existing Eastern business calendar, independent of the reader's display timezone.

This retrieves history that **exists**. It does not assert that all historical data has been imported or that old zero-row periods represent zero business activity. Earliest stored call date and coverage limitations are carried into answers. The existing **Recover CallGrid Interval** workflow is the backfill path: dry run, inspect every chunk, apply the reviewed interval, then verify it against CallGrid. It splits into business-day chunks, stops on incomplete source reads, marks API_RECOVERY provenance and does not advance routine checkpoints. It permits at most 62 business-day chunks per reviewed run; use reviewed monthly batches for older years. Availability remains bounded by CallGrid's actual API retention and completeness. No production backfill was run as part of this change.

Mail bodies remain transient under the existing authorization and retention policy. This change does not archive everybody's email or turn inferred model text into an authoritative business fact. A future business-memory writer must use the existing governed knowledge/observation contracts with evidence, scope, validity and explicit correction/supersession; it must not blindly save chat guesses.

## Production activation — after review and merge

1. On Netlify, preserve approved organization IDs, credentials and existing task allowlists. Ensure both provider keys are present server-side and `LOOP_AI_PROVIDERS` includes `anthropic,openai`. Append `loop.question.answer`, `loop.briefing.compose`, `situation.synthesis`, `situation.synthesis.private`, `situation.verify`, `situation.verify.private` to the intended `LOOP_AI_TASKS`; preserve the existing domain and triage tasks. Keep `LOOP_AI_ENABLED=true`.
2. Set `LOOP_INTELLIGENCE_WEB_SYNTHESIS=on`. Keep the existing Mail producer activation and recorded content-governance decision. Ensure `LOOP_INTELLIGENCE_ACTING_USERS` names the existing approved organization acting operators (`orgId=userId`); absence is a diagnosed gate, not grounds to invent an actor.
3. Use **Record AI Provider Policy**, provider `openai`, stage `production`, state `ACTIVE`, ceiling `COMMUNICATION_CONTENT`, confirmation `record ai-provider-policy production`. Its reason must identify the **actual** training/retention/region terms reviewed, reviewer and date. Do not manufacture a review or bypass this gate. Anthropic's existing valid policy can remain. Existing per-person content consent still applies.
4. Redeploy web after environment changes. AWS worker configuration and its provider secret remain separate. This web continuation uses the Netlify gateway and the existing authenticated scheduler, not the worker's credentials. Preserve worker producers, tasks and acting-user configuration; do not turn off a working worker path.
5. Ensure repository variable `INTELLIGENCE_MAIL_ENABLED=true` and the existing `INTELLIGENCE_MAIL_URL` / `INTELLIGENCE_MAIL_SECRET` match the deployed host. Run **Run Mail Intelligence** manually once. Endpoint responses must show actual outcomes; `NOT_ACTIVATED` and a green workflow are not success evidence.

## Acceptance: require production evidence

- Safe question GET shows task/provider activation and credential presence without secret values. Then a real question succeeds and its ledger row records `openai`, served model, INTERACTIVE, ANSWERED. A present key alone proves nothing.
- `loop.briefing.compose` has an ANSWERED run; Home and Headlines render the same new MODEL briefing and generation time. It explains current evidence and discloses gaps.
- Situation diagnosis states why a pass did or did not call the model. No independent source cluster is an honest absence of a synthesis opportunity, not Anthropic failing. CallGrid and Campaigns remain one source. If a situation is authored by Anthropic, OpenAI's independent verification is recorded distinctly or explicitly unavailable.
- Mail overview is refreshed after the classifier change. Its recent-window counts match the visible Mail dashboard at the same evidence time. Automatic messages do not become human reply obligations. Old per-thread backlog remains visible until processed; this change does not pretend all content has been read.
- Ask about yesterday's CallGrid figures and compare the cited window, revenue, payouts, telco, net and coverage to the source report. Test a missing historical year: answer says unavailable/incomplete history instead of zero revenue. Test an existing month and separate yearly comparison.
- Test employee, manager and admin accounts. No other person's private inbox or another organization's data is available. Creator/AI-employee principals cannot use a task outside their authority.
- Ask about an unsupported record, period or disconnected source: no invented answer. Chat's page path is a hint, not permission or a claim to have automatically applied every page filter.

## Scope limits

Existing domain landing pages and the CRM People page show their governed readings. This does not implement a distinct interpretation for every individual record and every arbitrary filter in the application. Chat can retrieve supported evidence at any shell page, but it is not arbitrary SQL, a source-completeness guarantee, an email archive, fine-tuning or an autonomous action agent. These limits must remain visible in product and rollout reporting.

## Local validation

- Web production build and web/database typechecks pass.
- Shared: 1,594 tests pass. Providers: 266 tests pass.
- Database: 1,805 pass; 215 opt-in Postgres tests skip because no test database is configured. Eight new gateway, request/evidence, date/history and mailbox/queue boundary tests pass in the relevant suites (HTTP boundary tests also run in web).
- Web: 964 pass; five fail. All five fail on unchanged main `85178e1` too: Person-record summary, People list identity boundary, People outreach navigation, Relationship linked-opportunity read boundary, and the CRM surface’s old Email-channel assertion. Unchanged main has a sixth failure for a missing CRM domain-reading section; this change adds that section. No additional web failures remain. Fifty targeted question/domain/freshness/time tests pass.
- Lint cannot run: the repository has no ESLint configuration and `next lint` opens its setup wizard. No lint rule, assertion or CI filter was disabled.
- These are local code checks with recorded providers, not live provider/account, database migration, content-completeness or production commissioning evidence.
