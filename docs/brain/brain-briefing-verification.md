# Brain Briefing verification harness

_Read-only, framework-free proof over the Brain Briefing projection. Not a UI,
not persistence, not runtime wiring, not a new test framework._

## Why this exists

PR #35 introduced a framework-free verification harness for the Brain Activity
flow; PR #37 extended the same pattern to the Call-Handling Metrics Assembler.
PR #38 introduced `projectBrainBriefing` — a pure projection that turns a list
of `BrainActivity` records into one stable, consumer-facing `BrainBriefing`
shape. This module extends the pattern once more: it PROVES, deterministically
and without a test runner, that the projection behaves exactly as documented.

This repo has no test framework, and none is introduced here. The harness is
plain, exported, pure TypeScript functions that run as part of the normal
typecheck/build (the green preview proves it compiles); `runBrainBriefingVerification()`
is available for a caller — or a future test runner — to execute the checks
and inspect a structured `BriefingVerificationReport`.

## Fixtures

Four `BrainActivity` records, assembled by `buildVerificationActivities()`:

- Two come from the Briefing's own deterministic demo
  (`exampleBriefingActivities()`, PR #38): a buyer-root-cause window that
  produces a `'high'`-severity, actionable recommendation, and an
  insufficient-evidence window that produces an honest `'unknown'`.
- Two are hand-built here and published through the REAL `publishBrainActivity`
  function (PR #31) from fully-typed `DiagnosticAssessment` +
  `RecommendationEnvelope` objects — never hand-assembled as raw `BrainActivity`
  literals — so each fixture is produced the same way production would produce
  one: a `'critical'` EMG-internal billing-outage activity (sharing its subject
  with the buyer fixture, to exercise subject grouping with multiple items),
  and a `'normal'` mild vendor-traffic signal on a third, distinct subject.

Together the four fixtures span every severity band and give three distinct
subjects, one of which (`buyer:acme-insurance`) carries two items.

## What is proved, and how

1. **Records project into a briefing.** `briefing.total` and `briefing.items.length`
   match the activity count, and every activity's id appears as an `activityRef`.
2. **Critical/high sort first.** The first item is `critical`, the second is
   `high`, and severity rank never regresses later in the list; `urgentCount`
   equals the critical+high count.
3. **Grouped by severity.** All four bands are present, in
   `critical, high, normal, low` order, and every item in a band matches that
   band's severity.
4. **Grouped by subject.** Three subject groups exist; the shared subject
   carries both its items with `topSeverity` correctly set to the more urgent
   of the two, and subject groups themselves are ordered by top severity.
5. **Inconclusive activities are surfaced, not hidden.** Exactly one fixture
   (the `'unknown'` one) appears in `briefing.inconclusive`, and no
   non-`'unknown'` activity is ever marked inconclusive.
6. **Honesty fields are preserved.** `evidence`, `missingEvidence`,
   `alternativesConsidered`, and `unknowns` are checked for **reference
   equality** against the source activity — proving the projection carries them
   through unchanged rather than copying, rebuilding, or fabricating them;
   `confidence` and `recommendation` are checked for exact equality.
7. **The buyer activity is actionable.** It carries a non-empty recommendation,
   is not marked inconclusive, and its confidence (`0.8`, from three concordant
   call-handling signals) is preserved.
8. **The unknown activity is inconclusive, not dropped.** It is present in both
   the flat item list and the dedicated `inconclusive` list, with
   `activityType: 'unknown'`.
9. **The projection is deterministic.** Two runs over the identical input
   produce byte-identical JSON, and a SHUFFLED copy of the same input produces
   the same item ordering and identical JSON — proving ordering is derived
   purely from severity/time/id, never from input array position.

## What this PR is NOT

- Not a UI, not persistence, not runtime wiring.
- Not a new test framework — no runner is added; these are plain exported pure
  functions, consistent with PR #35/#37.
- No schema changes, no CallGrid changes, no LLM. Additive and deterministic.

## Public API

- `runBrainBriefingVerification(): BriefingVerificationReport` — runs all nine
  scenarios and returns a structured, inspectable report.
- `buildVerificationActivities(): BrainActivity[]` — the fixed, deterministic
  fixture set described above.
- `CRITICAL_FIXTURE_ACTIVITY` / `NORMAL_FIXTURE_ACTIVITY` — the two hand-built,
  REAL-publisher-produced fixtures.
- Types: `BriefingCheckResult`, `BriefingScenarioResult`,
  `BriefingVerificationReport`.
