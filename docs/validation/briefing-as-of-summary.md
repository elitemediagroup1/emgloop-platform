# Recent AI analysis beside current facts

## Reproduced disconnect

Production worker logs at 10:08 Eastern on October 16 verify three COMPOSED briefings after #400, then the correct fifteen-minute refresh deferral. Matt's 10:29 page still leads with rule facts. The web insists on an exact current artifact fingerprint, so an incoming CallGrid call replaces the AI reading immediately while the model is intentionally paced. Model generation working did not establish the user-visible summary was working.

## Behavior and safety

Exact, fresh fingerprints still display the current stored summary normally. Otherwise current facts remain rule-derived. Alongside them, a same-local-day MODEL reading under thirty minutes old may be shown explicitly as of its original timestamp. The live metrics are newer and the UI says so. Current recorded facts and all their limitations remain available in a collapsed section. Home's Headlines preview caps both types of observations at three; the full Headlines page uses the same component.

Every historical line must have nonempty citations, and every exact cited reference and original context reference (including uncited context) must remain in the viewer's authorized source history. The existing scoped digest reads include unexpired, unwithdrawn readings even when stale. The existing source-state resolver checks connection liveness and Telegram consent, and the existing authorization repository separately rechecks Mail consent. A stale/pending reading can remain historical; disconnected, withdrawn, expired or revoked evidence cannot. These reference identifiers are display-only metadata, never added to current synthesis artifacts or AI context. If any disappears, hide the whole historical answer, headline and limitations included: validation does not prove line-by-line information flow, so filtering only the cited lines would be unsafe. Withdrawn or unauthorized private artifacts cannot be revived merely because their domain still exists. Stale but authorized history is never labelled current. Future, previous-day, thirty-minute-old or entirely unreferenceable summaries are hidden. No original timestamp, figure, fingerprint or AI wording is rewritten as current. A scoped latest-MODEL read preserves a useful recent reading when a later attempt fell back to RULE. It uses the existing immutable work brief history, organization/user/date/schema scope and an optional composer filter.

This patch makes no provider calls or source reads during render and writes no production state. It leaves #400 cadence, budgets, authorization, retention and live CallGrid ingestion unchanged. No packages, migration or worker settings are required. Merge and let Netlify deploy the web. Verify current metrics can change while an explicitly timestamped earlier AI reading remains visible, and that source access removal hides the historical answer.

## Mail and production limits

The supplied Home page explicitly excludes Mail as stale. Fresh rule counts on the Mail tile are not evidence that its AI interpretation is current. This patch preserves that exclusion. During the follow-up, AWS Core reauthentication selected management account 670682108352; new production logs could not be inspected. Mail rejection and coverage diagnosis remains open; no claim of full source coverage or financial reconciliation is made.

## Validation

Passed: 83 focused web tests; 20 focused database tests; database typecheck; web app and test typechecks; `git diff --check`. Regression tests cover changed call counts, timestamped rendering, age/day/future boundaries, exact-reference removal, private headline suppression, and retrieval of a MODEL version behind a later RULE version without crossing organization/user/date/schema scope.

The production web build compiled, passed its embedded type check, and generated all 96 static pages, then exited with `ENOTEMPTY` while removing `apps/web/.next/export`, the same cleanup failure observed before this patch. This is a failed build, not a passing result; Netlify preview/CI must pass before merge. Root lint remains blocked by the existing missing ESLint configuration (interactive Next setup prompt); no lint configuration was added in this scoped patch. No live UI verification was possible in the disconnected browser session.
