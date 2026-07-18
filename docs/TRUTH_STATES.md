# TRUTH_STATES.md — Truth is infrastructure

**Status:** Mandatory platform architecture. Not optional, not per-team, no special cases.
**Applies to:** every repository, service, intelligence module, API route, and UI surface.
**Implementation:** `packages/shared/src/truth` (exported from `@emgloop/shared`).
**Audience:** any engineer adding a measurement or rendering one.

---

## 1. Why this exists

EMG Loop could not distinguish six genuinely different facts about a number:

- the query ran and the answer is 42
- the query ran and the answer is really zero
- the query ran over part of the data
- we lack the evidence to answer
- the answer cannot exist yet
- the measurement failed

All six collapsed into `0`, `$0`, or "No data". The Marketplace redesign made the cost concrete:
`loadOrFallback` returned failure for a missing `DATABASE_URL`, an unreachable host, a missing
migration, **or any thrown exception** — and every caller mapped that to `null`, then to `0`. A total
database outage rendered pixel-identically to a healthy, empty marketplace: *"0 calls tracked · $0
revenue"*.

That is not a formatting bug. It is the platform **asserting knowledge it does not have**, which is
the one thing `CLAUDE.md` says we never do. Trust is the product; a number nobody can qualify is
worse than no number.

**The fix is structural, not disciplinary.** Three prior guards did not stop cross-tenant writes
either — Sprint 29A fixed that by making the unsafe call unwriteable. Same principle here.

---

## 2. The six states

| State | Meaning | Carries a value? | May render `0`? |
|---|---|---|---|
| `success` | Query completed, data complete, measurement trustworthy. | ✅ | ✅ |
| `empty` | Query completed. The value is **genuinely zero**. | ✅ (the zero) | ✅ |
| `partial` | Query completed over part of the data. Coverage **and** cause known. | ✅ (lower bound) | ❌ |
| `unknown` | Insufficient evidence to answer. Not an error. | ❌ | ❌ |
| `unavailable` | The answer cannot currently exist — unexposed, unmapped, structurally absent. | ❌ | ❌ |
| `error` | A measurement was attempted and failed. | ❌ | ❌ |

### The distinctions people get wrong

**`empty` vs `unknown`** — the most important pair. `0 buyers because the query ran and there are
none` is EMPTY: a real measurement. `0 buyers because no calls have been ingested` is UNKNOWN: we
have not looked. Rendering both as "0" is the original sin.

**`unknown` vs `unavailable`** — UNKNOWN can be resolved by *getting more data*. UNAVAILABLE cannot,
because there is nowhere for the data to come from yet: the provider does not expose it, or Loop has
no field to receive it. Different states because they imply different work by different people.

**`partial` vs `success`** — PARTIAL has a real value, but it is a **lower bound**. It may never be
presented as final, and it must always carry its coverage.

---

## 3. The zero rule

> **Only `SUCCESS` and `EMPTY` may render a numeric zero.**
>
> Null is never zero. Unknown is never zero. Unavailable is never zero. Error is never zero.

Enforced three ways, in order of strength:

1. **The type.** `value` does not exist on `unknown`, `unavailable` or `error`. Reading it is a
   compile error.
2. **`assertZeroRule`** — a runtime backstop that throws if a non-measured state ever renders digits.
3. **Tests** — `packages/shared/test/truth.test.ts` sweeps all six states for every rule.

---

## 4. Why you cannot get this wrong by accident

`Truth<T>` is a discriminated union where the non-value states have **no `value` property at all**:

```ts
const revenue: Truth<number> = await repo.revenue(orgId);

money(revenue.value)         // ✗ compile error — property does not exist
money(revenue.value ?? 0)    // ✗ compile error — cannot coalesce an absent property
if (hasValue(revenue)) money(revenue.value)   // ✓ narrowed, legitimate
```

This is asserted permanently in `packages/shared/src/truth/zero-rule.guarantee.ts` using
`@ts-expect-error`. If anyone weakens the model, those directives become unused, `tsc --noEmit`
fails, and the build stops. The guarantee cannot rot silently — verified by adding `value?: any` to
the base type and watching typecheck fail.

**There is deliberately no `valueOr(truth, 0)` helper, and there must never be one.** It would be the
single most convenient way to reintroduce every bug this model prevents. If you find yourself wanting
it, you want `foldTruth` or `renderTruth`.

---

## 5. Repository rules

**Do not return `number | null`.** Null cannot say *why*, and every caller invents its own meaning.

```ts
// ✗ Before — the caller cannot tell an outage from an empty org
async revenueCents(orgId: string): Promise<number | null>

// ✓ After
async revenueCents(orgId: string): Promise<Truth<number>>
```

Rules:

1. **A completed query returning 0 is `EMPTY`, not `UNKNOWN`.** Use `measuredCount` / `measuredList`.
2. **Wrap reads in `measure()`** so a thrown exception becomes `ERROR` instead of propagating into a
   caller that will render zero.
3. **A capped or bounded read is `PARTIAL`** with real coverage — use `measuredBounded`.
4. **Never invent a denominator.** If the true total is unknown, `coverage.total` is `null`.
5. **`measuredAt` is passed in, never read from a clock inside the helper.**

```ts
return measure(
  () => this.prisma.marketplaceCall.count({ where: { organizationId, ...window } }),
  measuredCount,
  { measuredAt: now.toISOString(), subject: 'marketplace.calls' },
);
```

---

## 6. Rendering rules

UI switches on **state**, never on `null`, `undefined`, or `0`.

```tsx
const d = renderTruth(revenue, (cents) => money(cents));
// d.text        → the value, or "—" when there is nothing to show
// d.tone        → good | neutral | caution | critical
// d.qualifier   → "lower bound", "not yet known", "measurement failed"
// d.note        → the operator-facing explanation
// d.unblockedBy → the action that resolves it
// d.trustworthy → true only for SUCCESS / EMPTY
```

- **Every state renders differently.** Six states, six distinguishable treatments.
- **The formatter is only invoked for value-bearing states**, so it can assume a real number and
  never defend against null.
- **`UNKNOWN_DISPLAY` is `—`.** Never `0`, never `$0`, never "No data".
- **Every non-`SUCCESS` state must show its note.** A qualifier without a reason is decoration.

`describeTruth` returns a plain description rather than JSX, so email, PDF export, and any future
client enforce the same rule as the web app.

---

## 7. Brain rules

The Brain consumes Truth rather than raw numbers, and must:

1. **Never reason over a non-value state as if it were zero.** No value means no conclusion.
2. **Propagate the weakest state.** Use `weakestState()` — a briefing built from one failed read and
   three good ones is not three-quarters trustworthy, it is compromised.
3. **Carry state into recommendations.** A `RecommendationEnvelope` derived from PARTIAL evidence
   must say so; its confidence is capped by its worst input.
4. **Turn `UNKNOWN` / `UNAVAILABLE` into `missingEvidence`**, not into silence. `Reason.unblockedBy`
   is exactly what belongs there.

This aligns with `BRAIN.md` §2.5 ("absent is absent, never zero") and §4.3 (coverage). Truth States
are the mechanism that section describes.

---

## 8. Future module rules

Every intelligence module — Marketplace, Talent, In My City, CRM Intelligence, AI Employees, and any
provider not yet built — uses this model unchanged. **There are no special cases.**

A module is compliant when:

- every measurement it exposes is a `Truth<T>`
- it never converts a non-value state into a number
- every `UNAVAILABLE` names its provider and what would unblock it
- its coverage denominators are real or explicitly `null`

If a domain seems to need a seventh state, that is a design discussion before it is code. Adding one
is a compile error at every `foldTruth` call site by design — that is the cost, and it is deliberate.

---

## 9. Migration status

Truth States are new. The platform is **not yet fully migrated**, and this is the honest ledger.

A full audit (Sprint 30) found the important structural fact: **most zeros are fabricated below the
UI, not in it.** `revenue-intelligence.repository.ts` and `marketplace-call.repository.ts` sum
unknown economics as `0` before any page renders, so migrating pages alone would produce components
faithfully displaying a zero invented three layers down. **The repository aggregates are the real
boundary.**

| Surface | Status |
|---|---|
| `packages/shared/src/truth` | ✅ Complete — 46 tests, compile-time guarantee asserted |
| Adoption enforcement | ✅ Ratchet in `truth-adoption.test.ts` — new violations fail the build |
| Marketplace Overview | ✅ Migrated — reference implementation |
| `MarketplaceCallRepository.coverageObservations` | ✅ Returns Truth |
| CallGrid confidence coverage metric | ✅ Fixed — no longer defaults unknown coverage to 0 |
| CRM Analytics "Avg Response" | ✅ Fixed — renders unmeasured, not "0 min" |
| Brain confidence display | ✅ Fixed — renders "unscored", not "0%" |
| `RevenueIntelligenceRepository` | ⚠️ Returns `QueryCoverage`; maps onto PARTIAL, not yet Truth. Sums `totalCents ?? 0` |
| `MarketplaceCallRepository.aggregateWindow` | ⚠️ Sums `?? 0`; per-dimension coverage counts exist but are not propagated |
| CallGrid `analyze.ts` prior-window lookups | ⚠️ `?? 0` treats an absent prior buyer as $0 earned, manufacturing infinite growth |
| Marketplace sub-pages (4) | ❌ 43 zero-coercions, recorded as a shrinking debt ledger |
| Executive Dashboard | ❌ Not migrated (no measurement coercions found) |
| Brain briefing / `RevenueHeadline` | ❌ `number \| null` on the platform's headline KPI |
| Provider boundary (`callgrid.provider.ts`, `callgrid-api.ts`) | ❌ `number \| undefined` at the outermost sensor edge |
| API routes · CRM | ❌ `serializeTruth` exists, unused |

**Migration order** — highest leverage first, each independently shippable:

1. **Repository aggregates** — `revenue-intelligence` and `marketplace-call` summation. This is where
   the zero is manufactured; everything downstream inherits it.
2. **The provider boundary** — `toNumber`/`numeric` returning Truth with an `unavailable` reason
   naming CallGrid would give every downstream layer provenance for free.
3. `RevenueIntelligenceRepository` public API → `Truth<T>` (its `QueryCoverage` already maps to PARTIAL).
4. `RevenueHeadline` / `BriefingRevenue` → Truth, so the headline KPI carries its own posture.
5. Marketplace sub-pages, lowering the debt ledger as each migrates.
6. Executive Dashboard, API routes (`serializeTruth`), CRM surfaces.

**Rule for new code, effective now:** any *new* measurement returns `Truth<T>`. This is enforced —
see §11. Migration of existing code is incremental; regression is not permitted.

---

## 10. Common mistakes

| Mistake | Why it is wrong | Instead |
|---|---|---|
| `truth.value ?? 0` | Does not compile — and if it did, it is the original bug | `foldTruth` / `renderTruth` |
| Returning `EMPTY` when you mean `UNKNOWN` | Claims a measurement you did not make | `EMPTY` only when the query ran and the answer is genuinely zero |
| `coverage.total = observed` | Fakes completeness | `total: null` when the denominator is unknown |
| `?? 0` inside an aggregate sum | Manufactures the zero below the UI, where no renderer can catch it | Track a coverage count and report PARTIAL |
| `ratio(x, y) ?? 0` | Collapses "unknown ratio" into "zero ratio" | Handle `undefined` explicitly |
| Treating an absent prior period as `0` | Manufactures infinite growth | Withhold the comparison |
| Rendering `0%` for unscored confidence | Reads as "certainly worthless" | Render "unscored" |

---

## 10. Change control

This document describes built behavior. If it and the code disagree, **the code wins and this file is
wrong** — fix it (`CLAUDE.md` §Documentation Rules).

Adding a state, removing the zero rule, or introducing a value-defaulting helper are architectural
changes requiring a decision from Matt, not a PR.

---

## 11. Enforcement

Adoption is enforced by `packages/shared/test/truth-adoption.test.ts`, which runs in the existing
`node --test` harness (`npm run -w @emgloop/shared test`).

**Why not an ESLint rule?** ESLint is not configured in this repository — no config, no dependency,
and `npm run lint` has never passed (`CLAUDE.md` §Validation). A rule there would enforce nothing
until that baseline is fixed. This test enforces today.

Four rules:

1. **No bare measurement methods.** A repository/service method returning `Promise<number>` cannot
   express "did not measure". Must return `Promise<Truth<number>>`.
2. **No zero-coercion on executive surfaces** — `?? 0` / `|| 0` on a measurement-named value. This is
   a **ratchet**: existing debt is recorded per-file and may only decrease. A new violation, or any
   violation in a new file, fails the build.
3. **Migrated surfaces are pinned at zero** and can never regress.
4. **No value-defaulting helper** (`valueOr`, `unwrapOr`, `orZero`…) may be added to the framework.

Exceptions require an entry in `ALLOWLIST` with a written reason of at least 40 characters. The
reason is printed on failure, so adding one is a reviewable act rather than a quick unblock.

**When you migrate a page**, lower its number in `ZERO_COERCION_DEBT`. When it reaches zero, delete
the entry — the ledger asserts this, so it cannot drift into historical trivia.
