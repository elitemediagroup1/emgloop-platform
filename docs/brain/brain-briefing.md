# Brain Briefing projection

_Read-only Brain-layer projection. Not a UI, not persistence, not runtime wiring._

## Why this exists

The Brain's single canonical output is the immutable `BrainActivity` record
(see `packages/brain/src/brain-activity.ts`). Every diagnoser, on any subject,
publishes that same shape. But a human-facing surface never wants _one_ activity
in isolation — it wants a **triaged, grouped view of many**: what is urgent, what
concerns which subject, and where the Brain is honestly unsure.

Without a shared projection, every surface (Daily Briefing, workspaces,
notifications, portals) would re-implement that sorting/grouping logic — and, to
do it, would reach past `BrainActivity` into diagnostics and recommendation
internals. That is exactly the coupling the Constitution forbids: **consumers
must read the Brain's output, never its internals.**

`BrainBriefing` is that shared shape. It is a pure, deterministic projection over
a list of `BrainActivity` records, and it is the **only** thing a consumer reads
to present the Brain's output.

## The flow

```
BrainActivity[]            (the Brain's canonical output)
      |
projectBrainBriefing(...)  (this projection — pure, no new decisions)
      |
BrainBriefing              (one stable, consumer-facing shape)
      |
Daily Briefing · Employee workspace · Business-owner workspace ·
Notifications · future portals
```

## What the projection guarantees

- **Severity first.** Items are globally ordered critical -> high -> normal ->
  low, then oldest-first by timestamp, then by activity id — a total, stable,
  reproducible order regardless of input order. `urgentCount` is the headline
  count of critical + high items.
- **Grouped by severity.** `bySeverity` lists only the bands that actually have
  items, each carrying its items and a subject sub-grouping.
- **Grouped by subject.** `bySubject` groups items that carry a subject, each
  group ordered by severity/time and the groups themselves ordered by their top
  severity. Items with no subject still appear in the flat and severity views.
- **Honesty preserved.** Every `BriefingItem` carries the underlying activity's
  `evidence`, `confidence`, `missingEvidence`, `alternativesConsidered`, and
  `unknowns` **verbatim** — nothing is collapsed, summarized away, or fabricated.
- **Uncertainty surfaced, never hidden.** Each item has an `inconclusive` flag,
  and the briefing exposes a dedicated `inconclusive` list. An activity is
  inconclusive when its type is `'unknown'`, or when it made no recommendation
  yet still carries open unknowns. The Brain's "I don't know yet" is a
  first-class, visible outcome.

## Why consumers read the Briefing, not diagnostics internals

A `BrainBriefing` is the Brain's **presentation contract**. Because it is a pure
projection of already-published `BrainActivity` records:

1. **One shape, many surfaces.** Daily Briefing, workspaces, notifications, and
   future portals all read the identical shape, so triage/severity ordering is
   consistent everywhere and defined in exactly one place.
2. **No leakage.** Consumers never import diagnosers, assessments, or
   recommendation builders. If internals change, the Briefing contract absorbs
   it; consumers do not break.
3. **Deterministic.** Given the same activities the briefing is byte-for-byte
   identical — no clock, no RNG, no I/O — so it is trivially testable and
   cacheable downstream.
4. **Traceable.** Each item keeps `activityRef` and `assessmentRef`, so a surface
   that needs the full envelope can follow the reference back to the canonical
   record without the Briefing having to inline everything.

## What this PR is NOT

- Not a UI. It is the shape a UI reads _from_.
- Not persistence. It performs no writes and defines no storage.
- Not runtime wiring. It is exported from the package barrel but not invoked by
  any app path.
- No schema changes, no CallGrid changes, no LLM. Additive and deterministic.

## Public API

- `projectBrainBriefing(inputs: BriefingInputs): BrainBriefing` — the projection.
- `isInconclusiveActivity(activity: BrainActivity): boolean` — the explicit
  uncertainty predicate.
- `BRIEFING_SEVERITY_ORDER` — the canonical severity ordering.
- Types: `BrainBriefing`, `BriefingItem`, `BriefingSeverityGroup`,
  `BriefingSubjectGroup`, `BriefingInputs`, `BrainBriefingResult`.
- Deterministic example: `exampleBriefingActivities()` /
  `demonstrateBrainBriefing()`, which reuse the published
  Observe -> Diagnose -> Recommend -> Publish flow to produce fixed activities
  (one buyer-root-cause recommendation, one honest `unknown`) and project them.
