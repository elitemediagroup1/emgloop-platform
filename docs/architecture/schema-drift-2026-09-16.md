# Migration history vs `schema.prisma` — the seven known differences

**Recorded 2026-09-16. Nothing here has been changed.** No applied migration was edited, no production
index was renamed, no schema was altered and no migration was dispatched. This record exists so that the
next person who runs `prisma migrate dev` is not surprised by it.

## How it was found

During the migration checkpoint for `20260918000000_ai_usage_ledger`, all 35 migrations on `main` were
replayed into a disposable local PostgreSQL 16 container. The result was then diffed against `main`'s
schema:

```
prisma migrate diff --from-url <local replay> --to-schema-datamodel packages/database/prisma/schema.prisma --script
```

The same comparison at the previously deployed commit `68ea9b1` (34 migrations) produced **byte-identical
output**. The differences predate migration 35, and the AI usage ledger introduced none.

## The differences

| # | What the migrations produce | What the schema expects | Introduced by |
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
- **`prisma migrate dev` (local)** replays the history into a shadow database, sees these seven
  differences, and **generates a new migration**: six `ALTER INDEX … RENAME` statements and one
  `ALTER COLUMN … DROP DEFAULT`. That migration would be harmless, but nobody should commit it by
  accident as part of unrelated work.
- **Production itself** most likely carries the same names as the replay, since these tables were created
  by these migrations after the 2026-07-09 baseline. That is inferred, not verified: confirming it needs a
  read-only production schema read, which this record did not do.

## Recommended fix (not done — its own small PR)

Align `schema.prisma` to the database rather than the database to the schema. This needs **no
migration**:

- Add `map: "<actual name>"` to the six `@@index` / `@@unique` declarations, using the names in the
  table above.
- Add `@default([])` to `observedSources`.

Then `prisma migrate diff` between a fresh replay and the schema is empty. No production index is
touched, and `migrate dev` stops proposing a migration.

To prevent a recurrence:
- write migration SQL from `prisma migrate diff` output;
- keep index names within 63 characters, or declare them with `map:`;
- add a CI check that replays migrations into an ephemeral database and fails on a non-empty diff.

## Related documentation correction

`docs/architecture/ai-usage-ledger.md` used to say the ledger's instants are `timestamptz`; they are
`timestamp(3)`, and the record now says so. The applied migration
`20260918000000_ai_usage_ledger/migration.sql` repeats the old wording in a header comment. That file is
**deliberately left unedited**: changing an applied migration changes its checksum, and Prisma would then
report it as modified.
