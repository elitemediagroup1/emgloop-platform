# The AI usage ledger

**Status (2026-09-16): implemented, NOT deployed.** The table, its migration
(`20260918000000_ai_usage_ledger`), `AiUsageLedgerRepository` and `DurableAiUsageLedger` exist on their
own branch. **Nothing writes the table** and the migration has not been dispatched. The AI runtime is
still `activated: false`, no provider credential is read, and no live model request exists anywhere.

This record exists because the S1 gateway reads budgets from an interface, and an interface cannot stop
a runaway bill. The durable counter behind it needed a table, a table needs a migration, and a migration
needs Matt — so it arrived on its own rather than inside a feature branch.

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
| `estimatedInputTokens`, `estimatedOutputTokens` | int, nullable | **The reserve.** Loop's estimate, written before dispatch. Kept apart from the report forever: a row still carrying only an estimate never reconciled |
| `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens` | int, nullable | As reported. Null where a provider did not say — never zero-defaulted, which would read as "free" |
| `unitCostBasis` | text, null | The price list version these tokens are valued with. **The cost authority** |
| `estimatedCostMicros` | int, null | The reserve's cost estimate, in integer micros. **Never the cost of record** |
| `outcome` | text | `IN_FLIGHT` while reserved; then ANSWERED / REFUSED_BY_MODEL / REJECTED_BY_LOOP / FAILED / CANCELLED |
| `failureClass` | text, null | Loop's taxonomy, never a provider's prose |
| `rejectionCodes` | text[] | Which contract rules the answer broke |
| `fellBackFrom` | text, null | The provider tried first, when one was |
| `attemptCount` | int | Retries inside the attempt |
| `requestedAt`, `completedAt` | timestamptz | **Server clock, Loop Time Authority.** Never a browser's, never a provider's |
| `latencyMs` | int | |
| `businessDate` | date | The organization's reporting day (`Organization.timezone`, default UTC), so a "daily cap" means a day somebody recognises. Used for the budget and nothing else |

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

1. **Before dispatch:** `spentOn(organizationId, businessDate)` — one indexed read of that day's rows.
   Tokens count **report over estimate**: a reconciled row counts what the provider said, an in-flight
   row counts what Loop reserved.
2. **Reserve, then reconcile.** `reserve` inserts the row **before** the call with the estimate;
   `reconcile` writes the reported usage after it. A crash between them leaves a row that over-counts
   slightly — the safe direction. Counting only after the call would let N concurrent requests each read
   a spend-to-date of zero; a test proves ten concurrent reserves are all visible to the budget.
3. **A retry is one row.** A second `reserve` for the same `(organizationId, invocationId)` is refused by
   the unique index and returns `false`; the reservation exists exactly once. The index — not a
   read-then-write — is what holds this, and mutation testing confirms it.
4. **Caps are evaluated by the pure `admitAiInvocation`**, which already exists and is already tested.
   This table only supplies the number it reads.

**Not yet wired.** The gateway still calls only `spentToday` and the post-hoc `record`.
`DurableAiUsageLedger.record` reconciles a reserved row, or writes and reconciles one if no reserve was
made, so the ledger is correct after the fact either way — but **only a gateway that calls `reserve`
before dispatch closes the concurrent-read window.** That wiring is its own slice, and it must land
before activation.

## 5. Retention

| Data | Retained | Why |
|---|---|---|
| Usage and cost rows | **Indefinitely** | They are financial and governance facts, and they are small |
| `contextManifestHash` | with the row | A hash, not content |
| Prompt / response bodies | **never stored** | See §2 |

An organization's deletion cascades its rows, as every other tenant-owned table does.

## 6. Product decisions (2026-09-16)

1. **Cost basis — reproducible.** Store the raw provider usage plus the price-list version
   (`unitCostBasis`). A final dollar amount is never the only record, so a corrected price re-values
   history instead of rewriting it. `estimatedCostMicros` exists only as the reserve.
2. **Business date — the organization's, only where a budget needs it.** `businessDate` follows
   `Organization.timezone` (default UTC) and is read in exactly one function, `aiBudgetDate`. Canonical
   instants stay UTC. The organization's zone is **not** a display timezone and must not become one; it
   is also unrelated to `BUSINESS_TIME_ZONE`, which is CallGrid's reporting calendar. An unusable zone
   string budgets on the UTC day, because failing open would mean no cap at all.
3. **Per-user cap — none at launch.** `principalUserId` is attribution. Nothing reads it to decide
   anything.

## 7. Migration dossier — `20260918000000_ai_usage_ledger`

**Dispatch is Matt's decision. It has not been dispatched.**

**What it does.** Creates `ai_invocations`: one table, one unique index, three read indexes, two foreign
keys (organization CASCADE, principal user SET NULL). Seven statements.

**What it does not do.** Zero DROP. Zero ALTER on any existing table. Zero UPDATE, DELETE or INSERT. No
backfill. No existing row is read, written or moved. The file is plain ASCII (see PR #152).

**How it was verified without a database.** `prisma migrate diff --from-schema-datamodel <main's schema>
--to-schema-datamodel <this schema> --script` derives the SQL Prisma expects; normalized statement by
statement, it is **identical** to the committed file. `prisma validate` passes.

**Lock and duration.** `CREATE TABLE` and indexes on a new, empty table take no lock on any existing
table and complete in milliseconds. The two `ADD CONSTRAINT … FOREIGN KEY` statements take a
`SHARE ROW EXCLUSIVE` lock on `organizations` and `users` for the duration of validating an empty table —
effectively instantaneous, but it is the one point that touches an existing table's lock queue.

**Before dispatching.**
1. The PR is merged and its content is on `main`: `git fetch origin && git diff --stat origin/main
   feat/ai-usage-ledger-migration` is empty. The workflow deploys whatever ref it is dispatched from, so
   dispatch from `main`.
2. The last deploy run is still `35047357515` (34 migrations), and no other migration is pending on `main`.
   `gh run list --workflow="Deploy Prisma Migrations" --limit 3`.

**Dispatch.** Actions → *Deploy Prisma Migrations* → *Run workflow* on `main`
(or `gh workflow run "Deploy Prisma Migrations" --ref main`).

**After it runs, the log must show:**
- `35 migrations found in prisma/migrations`
- `Applying migration 20260918000000_ai_usage_ledger` and `All migrations have been successfully applied.`
- `Database schema is up to date!` in the status step, with no failed or rolled-back migration.

**The table will be empty,** and must stay empty: nothing in the product writes it until the gateway
wiring slice lands and an operator activates the runtime.

**Rollback.** Prisma has no down migrations. The table is additive and unwritten, so leaving it in place
is harmless; removing it would be a new forward migration (`DROP TABLE "ai_invocations"`), reviewed like
any other. Do not hand-edit `_prisma_migrations`.

**Until this is deployed and the gateway reserves before dispatch, S1 must not be activated.** A live
provider behind a budget nobody can enforce is the one configuration this whole design exists to
prevent.
