# The AI usage ledger — design record

**Status:** DESIGN ONLY (2026-09-16). **No table exists. No migration is written. Nothing is deployed.**
This record exists because the S1 gateway reads budgets from an interface today, and an interface cannot
stop a runaway bill. The durable counter behind it needs a table, a table needs a migration, and a
migration needs Matt — so it is designed first, on its own, rather than arriving inside a feature branch.

## 1. Why an interface is not enough

`InMemoryAiUsageLedger` counts invocations in a process's memory. Netlify runs serverless: instances share
no memory, they come and go, and an organization's daily cap enforced per-instance is a cap multiplied by
however many instances happen to be warm. This is the **exact** shape of the webhook replay-map mistake
CLAUDE.md records — an in-memory map that is "close to decorative" on serverless.

A budget that is decorative is worse than no budget: it is a control somebody will trust.

## 2. What one row records

One row per **invocation attempt** — answered, refused, rejected or failed alike. A failure that consumed
input tokens cost money; a refusal is a fact about the system. Both are recorded.

| Field | Type | Why it is here |
|---|---|---|
| `id` | cuid | |
| `organizationId` | FK → organizations, **cascade** | Tenancy, and the budget grain |
| `invocationId` | text, **unique per organization** | Loop's correlation id, **stable across retries** — so a retried attempt updates one row rather than counting twice |
| `principalUserId` | FK → users, SET NULL | Whose authority assembled the context. Never a service account |
| `taskId`, `taskVersion` | text | Which question, in which version |
| `profile` | text | The capability profile routed on |
| `providerId`, `requestedModelId` | text | What Loop asked for |
| `servedModel` | text, null | What the provider says actually answered. Not always the same |
| `routingPolicyVersion` | text | Which routing table chose it |
| `templateId`, `templateVersion` | text | The instruction is the largest influence on the answer; an unversioned prompt makes a past answer unexplainable |
| `contextManifestHash` | text | **A hash of the ordered source refs — never the content.** Enough to prove two invocations saw the same evidence, useless for reconstructing it |
| `contextSourceCount` | int | How much evidence was supplied |
| `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens` | int, nullable | As reported. Null where a provider did not say — never zero-defaulted, which would read as "free" |
| `unitCostBasis` | text, null | The price list version used, so a cost can be recomputed rather than trusted |
| `estimatedCostMicros` | int, null | Integer micros. Null when not priced |
| `outcome` | text | ANSWERED / REFUSED_BY_MODEL / REJECTED_BY_LOOP / FAILED / CANCELLED |
| `failureClass` | text, null | Loop's taxonomy, never a provider's prose |
| `rejectionCodes` | text[] | Which contract rules the answer broke |
| `fellBackFrom` | text, null | The provider tried first, when one was |
| `attemptCount` | int | Retries inside the attempt |
| `requestedAt`, `completedAt` | timestamptz | **Server clock, Loop Time Authority.** Never a browser's, never a provider's |
| `latencyMs` | int | |
| `businessDate` | date | The organization's reporting day, so a "daily cap" means a day somebody recognises |

**Deliberately absent: the prompt and the response.** Storing bodies "for observability" would put
customer data and model output into a table with different retention and access rules from the sources
they came from — and it is the one field that makes a usage ledger a privacy incident. The provenance
record names the evidence; the evidence is read from its own authority under its own guard.

## 3. Indexes

- `@@unique([organizationId, invocationId])` — idempotent under retry
- `@@index([organizationId, businessDate])` — the budget read, which happens before every invocation
- `@@index([organizationId, taskId, requestedAt])` — per-task cost review
- `@@index([organizationId, outcome, requestedAt])` — refusal and failure rates

## 4. How a budget is actually enforced

1. **Before dispatch:** sum today's row for `(organizationId, businessDate)`. One indexed read.
2. **Reserve, then reconcile.** A row is written **before** the call with the estimated input cost, then
   updated with the reported usage. A crash between them leaves a row that over-counts slightly — the
   safe direction. Counting only after the call would let N concurrent requests each see a spent-to-date
   of zero.
3. **Caps are evaluated by the pure `admitAiInvocation`**, which already exists and is already tested.
   This table only supplies the number it reads.

## 5. Retention

| Data | Retained | Why |
|---|---|---|
| Usage and cost rows | **Indefinitely** | They are financial and governance facts, and they are small |
| `contextManifestHash` | with the row | A hash, not content |
| Prompt / response bodies | **never stored** | See §2 |

An organization's deletion cascades its rows, as every other tenant-owned table does.

## 6. Migration — prepared separately, dispatched by Matt

Additive: one table, four indexes, two foreign keys. Zero DROP, zero backfill, no existing table touched.
It will be its **own PR**, and **HARD STOP before dispatch** — as R2's was.

**Until it is deployed, S1 must not be activated.** A live provider behind a budget nobody can enforce is
the one configuration this whole design exists to prevent.

## 7. Open decisions for Product

1. **Cost basis:** does Loop store an estimated cost at all, or only tokens (and price them at read time
   from a versioned price list)? **Recommendation: store tokens plus the price-list version; compute cost
   at read time**, so a corrected price does not require rewriting history.
2. **Business date:** the organization's reporting calendar, or UTC? **Recommendation: the organization's**,
   matching how CallGrid's reporting day already works.
3. Whether a per-user cap exists in addition to per-organization. **Recommendation: not at launch** —
   there is no evidence of the need, and an unused control still has to be maintained.
