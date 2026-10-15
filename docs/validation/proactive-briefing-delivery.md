# Proactive briefing delivery — 2026-10-15

Production #392 was inspected on Home, Headlines and Intelligence status. Home showed calls arriving and financial amounts with 85% field coverage. Headlines showed an unmeasurable roofing objective and no stored business briefing for Matt. The ledger had a rejected Anthropic briefing invocation, while Matt had no briefing invocation recorded. This does not identify the precise production rejection code or prove a CallGrid ingestion error. The browser could not inspect the source CallGrid report because credential protection blocked that observation; financial reconciliation remains unverified.

## Corrections

- Work briefs serve multiple generators. Both the composer and page loader now query the Loop briefing schema explicitly, retaining person/organization/date scope. A newer unrelated daily record cannot shadow the stored Loop briefing. Version allocation still spans every record, and nothing overwrites prior versions.
- The briefing prompt now states the existing 240-character line limit, four-limitations limit, exact shape, and prohibition on derived figures. The template version advances to invalidate reuse of old prompt results. Validators, provider routes and spending caps are unchanged.
- One bounded repair is allowed after rejected output or an unjustified all-clear claim, using original evidence and the same gateway. A second failure remains an honestly marked RULE briefing with bounded rejection codes. Policy/auth failures are not repaired. The scheduled request propagates a 45-second cancellation signal to provider attempts.
- Scheduler recipients must be active members with intelligence permission. Missing daily briefs are served first; once everyone has one, stable rotation prevents an unchanged reused brief from monopolizing every future pass.
- Independent overview and synthesis steps may run after an earlier Mail step fails. Briefings run before optional situation synthesis. Every target is attempted despite an independent request failure, but the workflow still fails if a request failed.
- Home Headlines receives the same stored business briefing as the full Headlines page. Measured objective signals remain separate, preserve their evidence rules, and cannot acquire fabricated measured Headline records from AI prose. Financial-field coverage is explained separately from connection health; no missing amounts become zero or complete totals.

## Validation and production acceptance

Validation: 38 focused contract/database tests, 55 Home/briefing rendering tests and two recipient-selection tests pass (95 total). Database/web typechecks and the production build pass. Focused tests cover schema isolation, the actual output contract, bounded repair, cancellation, all-clear rejection under partial coverage, recipient fairness, a real shell continuation with failed situation requests, and rendered Home/Headlines boundaries. No migration, credential, dependency, data-policy, provider-routing or budget change is required. Existing ESLint configuration remains absent; no checks are disabled.

After merge/deploy, run the existing **Run Mail Intelligence** workflow or observe its next scheduled pass. Confirm an ANSWERED `loop.briefing.compose` invocation for the intended viewer, a stored MODEL briefing for that viewer's local date, and matching supported summaries on Home and Headlines. If output is still rejected, inspect recorded rejection codes; do not loosen validation to display it. Run the remaining scheduled targets if more eligible viewers lack a daily brief.

PR #393 is independent and still required for direct Mail conversation retrieval. A successful business briefing is not proof of exhaustive Mail review, source CallGrid reconciliation, or historical backfill. The roofing objective is not automatically deleted or reconfigured.
