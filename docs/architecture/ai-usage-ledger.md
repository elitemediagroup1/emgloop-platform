# The AI usage ledger

**Status (2026-09-16): table deployed; gateway wired (AI-1); runtime OFF.** The migration
`20260918000000_ai_usage_ledger` is applied in production (run `35103219698`, 35 migrations). The
gateway now reserves every provider call in this table before making it (§4). **Nothing writes the table
yet**, because the runtime is off: activation is an allowlist that is empty by default, no provider
credential is read by the runtime, and no live model request exists anywhere.

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
| `profile` | text | The **capability route** the task declared (COMMUNICATION, TECHNICAL_ANALYSIS, GENERAL_REASONING). Since B2 it replaces the retired capability profile; the column kept its name because renaming it needs a migration. Rows written earlier hold the retired words and are read with `aiLedgerCapabilityOf`, which never maps them onto a route |
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
| `fellBackFrom` | text, null | `provider/model` this call stands in for: set on a fallback call, and on a first call when the policy's primary was killed or not enabled. Null on a retry of the same model |
| `attemptCount` | int | **Which call of its invocation this row is** (1, 2, …). See §4: every provider call is its own row |
| `requestedAt`, `completedAt` | `timestamp(3)` (no time zone) | **Server clock, stored as UTC, Loop Time Authority.** Never a browser's, never a provider's. The repository convention for every instant is Prisma's `timestamp(3)`, written in UTC; there is no `timestamptz` column anywhere in the schema. (This record previously said `timestamptz`; that was wrong. The applied migration's header comment carries the same wording and is deliberately left unedited, because changing an applied migration file changes its checksum.) |
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

The gateway (`services/ai-runtime/gateway.ts`) follows one sequence for every invocation: the principal
is the session's person in the session's organization, they may invoke the task, the context is valid,
the runtime is activated for this organization, task and provider, no kill switch applies, a route
exists, and a cheap budget check passes. Only then:

1. **Every provider call is its own row.** A retry is a second call and a fallback is a second call.
   Each spends money, so each is reserved before it is made and reconciled after. The first call's key
   is the invocation id; later calls append `.2`, `.3`, …
2. **Reserve inside a serializable transaction.** `DurableAiUsageLedger.reserve` reads the spend and
   inserts the row in **one** `SERIALIZABLE` transaction. Postgres aborts one of two conflicting
   reservations; the loser re-reads (up to three attempts) and is refused if there is no longer room —
   or refused as `RESERVATION_CONTENDED` if it keeps losing. No raw SQL, no advisory lock.
   *Proven against real Postgres* (`ai-usage-ledger.postgres.test.ts`, opt-in, local only): 30
   concurrent reservations from six connections against a cap of five never admit more than five.
   Under `READ COMMITTED` the same test admitted 11–15.
3. **No reservation, no call.** A refused or failed reservation means the provider is not touched —
   including for a fallback.
4. **Report over estimate.** A reconciled row counts what the provider reported; an in-flight row, or a
   failed call the provider reported nothing for, keeps counting its reserve. Nothing is ever recorded
   as zero because it was unreported.
5. **A call whose spend cannot be recorded is not shown.** If reconciliation fails, the answer is
   withheld (`LEDGER_UNAVAILABLE`); the reserve still counts, which is the safe direction.
6. **What "room" means** is the pure `aiBudgetRefusals`: one more call of this size must fit — the call
   being asked for is included — in the per-call limits, the task's daily cap, the organization's daily
   cap and the global cap. A missing budget, an unknown budget class, or a cap of zero refuses.

**The windows.** Organization and task caps use the organization's business day
(`Organization.timezone`). The global cap is a **trailing 24 hours** across every organization the
runtime is enabled for, because business days differ between organizations.

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
