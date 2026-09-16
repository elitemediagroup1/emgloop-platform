# Migration history vs `schema.prisma` — the seven known differences

**Recorded 2026-09-16. Aligned in B1 on the schema side only** (see *Resolution* below).

| | State after B1 |
|---|---|
| Migration history | **Unchanged.** 35 migrations; no file added or edited (checksums identical before and after) |
| Database | **Unchanged.** No production access; no DDL anywhere except a throwaway local replay |
| Prisma schema description | **Aligned.** Six `map:` names and one `@default([])` |
| Replay drift | **Zero.** `prisma migrate diff` from a clean replay to the schema reports "No difference detected" |

No applied migration was edited, no production index was renamed, and no migration was created or
dispatched. This record exists so that the next person who runs `prisma migrate dev` knows why it
proposes nothing, and what it used to propose.

## How it was found

During the migration checkpoint for `20260918000000_ai_usage_ledger`, all 35 migrations on `main` were
replayed into a disposable local PostgreSQL 16 container. The result was then diffed against `main`'s
schema:

```
prisma migrate diff --from-url <local replay> --to-schema-datamodel packages/database/prisma/schema.prisma --script
```

The same comparison at the previously deployed commit `68ea9b1` (34 migrations) produced **byte-identical
output**. The differences predate migration 35, and the AI usage ledger introduced none.

## The differences (as they stood before B1)

| # | What the migrations produce | What the schema expected before B1 | Introduced by |
|---|---|---|---|
| 1 | `integration_events."observedSources"` has `DEFAULT '{}'` | `observedSources String[]` with no `@default` | `20260823000000_ci_stage3_observation_provenance` |
| 2 | index `crm_relationship_events_organizationId_relationshipId_sequen_id` | `..._relationshipId_seque_idx` | `20260917000000_crm_r2_relationship_participant` — the migration wrote a **64-character** name. PostgreSQL silently truncates identifiers to 63, and Prisma truncates differently when it derives the name. |
| 3 | index `provider_fact_revisions_org_decision_observedAt_idx` | `provider_fact_revisions_organizationId_decision_observedAt_idx` | `20260824000000_ci_stage3_provider_fact_revisions` (hand-shortened name) |
| 4 | index `provider_fact_revisions_org_provider_external_idx` | `provider_fact_revisions_organizationId_provider_externalId_idx` | same |
| 5 | index `observation_day_identity` | `provider_observation_days_organizationId_provider_stream_bu_key` | `20260818`, `20260820`, `20260821` CI Stage 3 migrations (custom name) |
| 6 | index `poll_checkpoint_identity` | `provider_poll_checkpoints_organizationId_provider_stream_key` | `20260825000000_ci_stage3_poll_checkpoint` (custom name) |
| 7 | index `work_dependencies_organizationId_dependsOn_resolvedAt_idx` | `work_dependencies_organizationId_dependsOnWorkInstanceId_re_idx` | `20260910000000_work_os_execution_governance` (hand-shortened name) |

**None of these changes query behaviour.** Every index covers the columns the schema declares; only
its name differs. The default only matters when an insert omits the column. In that case the database
supplies `'{}'`, which is what the ingestion code expects. If the column were ever aligned by dropping the
default instead, such an insert would fail, so the safe alignment is the schema-side one below.

## What each tool will do

- **`prisma migrate deploy` (production)** applies migrations and never compares schemas. It is
  unaffected. Run `35103219698` reported "Database schema is up to date!", which is true of the migration
  ledger. That message does not mean "no drift".
- **`prisma migrate status`** is unaffected, for the same reason.
- **`prisma migrate dev` (local).** Before B1, it replayed the history into a shadow database, saw these
  seven differences, and **generated a new migration**: six `ALTER INDEX … RENAME` statements and one
  `ALTER COLUMN … DROP DEFAULT`. **After B1 it proposes nothing:** `prisma migrate diff
  --from-migrations … --to-schema-datamodel …` with a shadow database reports "No difference detected".
- **Production itself** most likely carries the same names as the replay, since these tables were created
  by these migrations after the 2026-07-09 baseline. That is inferred, not verified: confirming it needs a
  read-only production schema read, which this record did not do.

## Resolution (B1, 2026-09-16): schema-side, no migration

`schema.prisma` now describes the database the migrations create, rather than the database being
changed to match the schema. The change is limited to `packages/database/prisma/schema.prisma`:

| # | Declaration | Change |
|---|---|---|
| 1 | `IntegrationEvent.observedSources` | `String[]` → `String[] @default([])` |
| 2 | `CrmRelationshipEvent` `@@index([organizationId, relationshipId, sequence])` | `map: "crm_relationship_events_organizationId_relationshipId_sequen_id"` |
| 3 | `ProviderFactRevision` `@@index([organizationId, decision, observedAt])` | `map: "provider_fact_revisions_org_decision_observedAt_idx"` |
| 4 | `ProviderFactRevision` `@@index([organizationId, provider, externalId])` | `map: "provider_fact_revisions_org_provider_external_idx"` |
| 5 | `ProviderObservationDay` `@@unique(…, name: "observation_day_identity")` | add `map: "observation_day_identity"`; `name:` unchanged |
| 6 | `ProviderPollCheckpoint` `@@unique(…, name: "poll_checkpoint_identity")` | add `map: "poll_checkpoint_identity"`; `name:` unchanged |
| 7 | `WorkDependency` `@@index([organizationId, dependsOnWorkInstanceId, resolvedAt])` | `map: "work_dependencies_organizationId_dependsOn_resolvedAt_idx"` |

Each name was read from a clean replay (`pg_indexes`) before the edit. The replay confirmed that items
5 and 6 are unique indexes, and that item 2's name is PostgreSQL's truncation of a 64-character
identifier (the replay prints the truncation notice).

**How it was proven** (local only):
1. All 35 `migration.sql` files were applied in order with `psql` (one transaction per file,
   `ON_ERROR_STOP`) to fresh PostgreSQL 18.6 and 16.15 containers. All 35 applied on both. No Prisma
   migrate command was run against them.
2. **Before the edit,** `prisma migrate diff --from-url <replay> --to-schema-datamodel schema.prisma
   --script` printed the seven statements above.
3. **After the edit, all three computations report no difference:**
   - `--exit-code` from both replays prints "No difference detected" and exits 0 (the `--script` form
     prints "This is an empty migration.");
   - the reverse direction (schema → replay) is empty;
   - `--from-migrations … --shadow-database-url …` (what `migrate dev` computes) is empty.

   The same `--from-migrations` computation against the pre-B1 schema still prints the 7 statements,
   which shows the check detects drift.
4. **Checks:**
   - `prisma validate` passes, and `prisma format` would change nothing.
   - `prisma generate` succeeds, and the generated client's `index.d.ts` is **byte-identical** before and
     after.
   - The only datamodel difference is `observedSources` gaining `default: []`. Nothing in the repository
     reads the datamodel.
   - The compound unique names `observation_day_identity` and `poll_checkpoint_identity` are unchanged,
     because they come from `name:`, which was not touched.

**Production** was not read. Its index names are still *inferred* to match the replay, since those
tables were created by these migrations after the 2026-07-09 baseline. B1 does not depend on that
inference:
- `migrate deploy` never compares schemas;
- queries never use index names.

Confirming it would need an authorized read-only schema check.

To prevent a recurrence (**not built yet**):
- write migration SQL from `prisma migrate diff` output;
- keep index names within 63 characters, or declare them with `map:`;
- add a CI check that replays migrations into an ephemeral database and fails on a non-empty diff.

## Related documentation correction

`docs/architecture/ai-usage-ledger.md` used to say the ledger's instants are `timestamptz`; they are
`timestamp(3)`, and the record now says so. The applied migration
`20260918000000_ai_usage_ledger/migration.sql` repeats the old wording in a header comment. That file is
**deliberately left unedited**: changing an applied migration changes its checksum, and Prisma would then
report it as modified.
