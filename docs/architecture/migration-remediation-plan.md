# Migration Remediation Plan (release blocker)

**Status:** OPEN — tracked release blocker. The Loop Cognitive Architecture is
**not production-ready** until this is resolved. This plan is documentation only;
**no repair is performed in the cognitive-architecture branch** (one objective per
branch, and migration repair touches release tooling, not cognitive code).

**Owner action required:** a human runs the controlled deployment steps below.
Do **not** run `prisma migrate deploy` against production until step 3 is done.

---

## 1. The exact broken migration

- **File:** `packages/database/prisma/migrations/20250626000000_sprint_11_provider_category_ingestion_analytics/migration.sql`
- **Invalid statement:** line 1 begins with a Unicode **em-dash (U+2014)** *before*
  the `--` comment marker:
  ```
  —-- Sprint 11 — First Live Integration (ServicesInMyCity + CallGrid)
  ```
  Postgres reads the leading `—--` as SQL (not a comment) and aborts:
  `ERROR: syntax error at or near "—"` (SQLSTATE 42601). The intended line is a
  comment: `-- Sprint 11 — First Live Integration …`.
- **Blast radius:** 5 migration files contain em-dashes, but only this one fails —
  the other four (`sprint_4`, `pr75_work_os`, `marketplace_call`,
  `marketplace_auction_report_snapshots`) have the em-dash *inside* a valid `-- `
  comment, which Postgres accepts. **Only `sprint_11` blocks replay.**

## 2. Does production already contain the intended schema effect?

**Yes.** This migration's effect is "add `INGESTION` and `ANALYTICS` members to the
`ProviderCategory` enum." Production actively uses both values today (CallGrid
ingestion + analytics run against the live tenant), so the enum members already
exist in the production database. The migration is a **historical reconstruction**
of a change prod already has — re-running its DDL is neither needed nor safe to
assume idempotent.

## 3. Can the migration be corrected safely without changing applied prod state?

**Yes.** The only defect is in a **comment line**. Correcting `—--` → `--`:
- changes **zero** executable DDL,
- does **not** alter any applied production state,
- makes the file replay cleanly on a database from zero.

The fix is a one-character-class comment correction, done in a **dedicated PR**
(not this one), with the same correction applied to the other four em-dash headers
opportunistically (pure hygiene, no behavior change).

## 4. How Prisma migration history will be baselined

Production has **no `_prisma_migrations` table** — Prisma does not know any
migration is applied. Baseline it by recording every existing migration as already
applied, **without executing** any of them (`migrate resolve --applied`), because
the schema they describe already exists in prod. This creates and populates
`_prisma_migrations` so future `migrate deploy` runs apply only *new* migrations.

## 4a. The cognitive migrations, in order

The Loop Cognitive Architecture adds **three** additive migrations. They must be
applied in this order; each is `prisma migrate diff`-generated and contains **zero**
`DROP`, rename, or column-type change, so every one is safe to apply on top of the
current production schema and replays cleanly from an empty database.

1. **`20260723000000_loop_cognitive_architecture_foundation`** — Increment 1.
   16 new models + 30 new enums (identity / role / memory / knowledge / relationship /
   governance / active-state / evidence / outbox / hypothesis / org-knowledge /
   subscription / decision). Additive, 0 `ALTER`/`DROP`. **+16 cognitive tables.**
2. **`20260723000001_cognitive_processing_attempt`** — Increment 2.
   1 new model (`cognitive_processing_attempts`) + 1 enum (`ProcessingAttemptStatus`)
   for retry/dead-letter bookkeeping. No existing table altered/dropped. **+1 table.**
3. **`20260723000002_cognitive_state_change_delivery`** — Increment 3.
   1 new model (`state_change_deliveries`) + 1 enum (`DeliveryStatus`), plus **two
   additive `ADD COLUMN`s** — `state_change_subscriptions.required` (`DEFAULT false`,
   so existing subscriptions stay optional) and `cognitive_decisions.idempotencyKey`
   (nullable; NULLs are distinct in Postgres, so the new partial-by-nature unique binds
   only keyed rows) — and four indexes. Zero `DROP`/rename/type-change. **+1 table.**

Net cognitive footprint after all three: **18 tables** + their enums. In the future
baseline these three are the **only** migrations marked *pending* — every pre-cognitive
migration is `resolve --applied` (already in prod), so `migrate deploy` runs exactly
these three, in order, and nothing else.

## 5. How a clean database migrates from zero

After the comment fix (step 3), the whole chain replays on an empty database:
```
DATABASE_URL=<clean-db> npx prisma migrate deploy
```
Validated in this increment via schema-diff on throwaway Postgres:
- Increment 1: full schema applies from empty (66 tables).
- Increment 2: full schema applies from empty (67 tables); the additive migration
  also applies cleanly on top of the Increment-1 schema.
- Increment 3: full schema applies from empty (68 tables); the additive migration
  also applies cleanly on top of the Increment-2 schema.

## 6. How the current production schema is brought under management

1. Fix the `sprint_11` comment (dedicated PR); confirm from-zero replay passes.
2. Baseline production: create `_prisma_migrations` and mark **all** existing
   migrations `--applied` (they already exist in prod — resolve, don't run).
3. From then on, new migrations (including the three cognitive migrations) are
   applied with `migrate deploy`, and the Netlify build step is upgraded from
   `prisma generate` only to `prisma migrate deploy && prisma generate` **in a
   separate, reviewed change** — never as a side effect of a feature branch.

## 7. Backup and rollback requirements

- **Backup (mandatory, before any command):** full `pg_dump` of production to
  durable storage; verify the dump restores into a scratch database before
  proceeding.
- **Rollback:**
  - Baselining writes only to `_prisma_migrations` (metadata). To undo:
    `DROP TABLE _prisma_migrations;` (returns to the pre-baseline state).
  - The three additive cognitive migrations create only new tables/enums/columns. To
    undo a mistaken apply: `DROP TABLE` the 18 cognitive tables + `DROP TYPE` the
    cognitive enums + `DROP COLUMN` the two Increment-3 additions
    (`state_change_subscriptions.required`, `cognitive_decisions.idempotencyKey`) —
    none have dependents — or restore from the pre-apply `pg_dump`.
  - The comment fix is non-destructive and needs no rollback.

## 8. Exact commands for the controlled deployment (human-run)

> Run against production **only** after the `sprint_11` comment fix is merged and a
> verified backup exists. `$PROD_URL` is the production connection string held by
> the operator — never committed.

```bash
# 0. Backup and verify restore into a scratch DB first.
pg_dump "$PROD_URL" -Fc -f prod_pre_cognitive.dump
#    (restore-test prod_pre_cognitive.dump into a scratch DB; confirm success)

# 1. Baseline: record every EXISTING migration as applied WITHOUT running it.
for m in \
  20250624000000_sprint_4_real_data_layer \
  20250626000000_sprint_11_provider_category_ingestion_analytics \
  20260707000000_pr75_work_os_blueprint_runtime_v1 \
  20260708000000_loop_event_gateway \
  20260716000000_verified_knowledge_service \
  20260717000000_marketplace_call \
  20260719000000_marketplace_auction_report_snapshots ; do
    DATABASE_URL="$PROD_URL" npx prisma migrate resolve --applied "$m"
done

# 2. Confirm prod is now baselined and only the cognitive migrations are pending.
DATABASE_URL="$PROD_URL" npx prisma migrate status

# 3. Apply ONLY the new, additive cognitive migrations.
DATABASE_URL="$PROD_URL" npx prisma migrate deploy

# 4. Verify the 18 cognitive tables exist and the app still boots.
DATABASE_URL="$PROD_URL" npx prisma migrate status
```

## Exit criteria (all required to lift the blocker)

- [ ] `sprint_11` comment fixed (dedicated PR) and from-zero replay green in CI.
- [ ] Production backed up and restore-tested.
- [ ] Production baselined (`_prisma_migrations` populated; `migrate status` clean).
- [ ] Cognitive migrations applied via `migrate deploy`; 18 tables verified.
- [ ] Netlify build upgraded to run `migrate deploy` (separate reviewed change).

Until every box is checked, the cognitive architecture stays **not
production-ready** regardless of code readiness.
