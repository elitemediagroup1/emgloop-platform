# Runbook: Prisma Migrate Baseline Recovery (EMG Loop production)

**Status:** one-off recovery. NOT wired into Netlify builds.
**Owner branch:** `recovery/prisma-baseline-migrate`
**Related script:** `scripts/recovery/baseline-and-migrate.sh`
**Related preflight:** `scripts/recovery/preflight-checks.sql`

---

## Why this baseline exists

The production database predates Prisma Migrate management. It contains all
pre-Work-OS EMG Loop tables, but it has **no `_prisma_migrations` table**, so
Prisma has no record of which migrations were applied. We need to bring the
database under Prisma Migrate management without recreating existing tables and
without losing data.

Prisma's supported workflow for a database created outside Prisma Migrate is
**baselining**: mark migrations that are already reflected in the database as
"already applied" so Prisma records them (with real checksums) but does **not**
re-run their SQL.

## Why the baseline uses the two existing migrations (not a generated one)

The repository already contains the migrations that describe the pre-Work-OS
schema:

- `20250624000000_sprint_4_real_data_layer`
- `20250626000000_sprint_11_provider_category_ingestion_analytics`

These were verified against commit `bcc4089a0f028893246a8da65a23d77c7f8c0253`
— the last commit before Work OS (PR #75) — whose schema contains exactly the
30 pre-Work-OS models and **zero** Work OS models.

We therefore do **NOT** generate a new `--from-empty` baseline. Generating one
would create a competing, duplicate description of tables that already have
committed migrations, which is itself a form of fabricated history and a source
of drift. The two existing migrations ARE the baseline.

## Why Work OS is excluded from the baseline

The seven Work OS tables (`blueprints`, `blueprint_stages`, `work_instances`,
`work_stages`, `work_assignments`, `work_notifications`, `work_comments`) do
**not** exist in production yet. They must be genuinely created, so the Work OS
migration must be *applied* (its SQL executed), not baselined. Baselining it
would tell Prisma the tables exist when they do not — and the app would keep
crashing on `work_stages`.

## Why `migrate resolve --applied` is used

`prisma migrate resolve --applied <name>` records a migration as applied in
`_prisma_migrations` **without running its SQL**, and Prisma computes the
**real** checksum from the committed migration file. This is how we adopt the
two pre-existing migrations without touching existing tables. No checksums are
fabricated; no rows are hand-written.

## Why `migrate deploy` is safe afterward

`prisma migrate deploy` applies only migrations **not yet recorded as applied**.
After the two baselines are resolved, the only unapplied migration is Work OS,
so `deploy` runs exactly its SQL and nothing else. `deploy` never resets and
never drops data; it is the production-safe apply command.

## Why `db push` is intentionally prohibited

`prisma db push` force-syncs the schema to the database **without creating or
recording migrations**, and can drop columns/tables to make the database match.
It bypasses migration history entirely and can cause data loss. It is banned for
this recovery and for production in general.

---

## Prerequisites

- `DIRECT_DATABASE_URL` — the Neon **direct (non-pooled)** connection string.
  Migrations must never run over the pooled endpoint.
- `SHADOW_DATABASE_URL` — optional; not required for resolve/deploy.
- A **Neon branch/snapshot taken immediately before running** (rollback point).

## How to run (CI or one-off deploy job — NOT the Netlify build)

```
DIRECT_DATABASE_URL="<neon-direct-non-pooled-connection-string>" \
  bash scripts/recovery/baseline-and-migrate.sh
```

The script will:
1. Verify the three expected migration folders exist.
2. Verify the baseline migrations contain no Work OS tables.
3. Run read-only preflight checks against production (aborts if
   `_prisma_migrations` exists or any Work OS table already exists).
4. `migrate resolve --applied` for sprint_4 and sprint_11.
5. `migrate deploy` (applies Work OS only).
6. `migrate status` (verification).

## Safety checks (script aborts if any fail)

- `DIRECT_DATABASE_URL` missing.
- Any of the three expected migration folders missing.
- A baseline migration unexpectedly contains a Work OS table.
- `_prisma_migrations` already exists in production.
- Any Work OS table already exists before deploy.

## Verifying success

- `prisma migrate status` reports the schema is up to date, no drift.
- `_prisma_migrations` contains exactly three rows (sprint_4, sprint_11,
  Work OS) with real checksums.
- The seven Work OS tables exist and are selectable.
- The application no longer crashes querying `work_stages`.

## Rollback

If anything fails, restore the pre-run Neon branch/snapshot. `resolve` only
writes bookkeeping rows and `deploy` runs inside a transaction, so restoring the
snapshot returns production to its exact prior state. Existing tables are never
modified by this process.

## After recovery: PR #78

Keep the `migrate deploy` pipeline PR (#78) as a Draft until this baseline
recovery has succeeded in production and `migrate status` is clean. Merging the
auto-deploy pipeline **before** baselining would run `migrate deploy` against a
database with no `_prisma_migrations`, re-triggering the original incident. Once
baseline + Work OS are confirmed applied, merge #78 and add `migrate status` as
a CI drift gate.


## Running the recovery via the manual GitHub Actions workflow

The recovery script can be run from GitHub Actions instead of a local machine.
The workflow is `.github/workflows/prisma-baseline-recovery.yml`. It is
**manual-only** (`workflow_dispatch`), has **no push / pull_request / schedule
triggers**, and refuses to run unless the operator types an exact confirmation
phrase. It uses the `DIRECT_DATABASE_URL` GitHub secret and never prints the
connection string.

### 1. Take a Neon branch/snapshot FIRST (required)

> **WARNING:** This workflow modifies the production database schema. Before
> running it, create a Neon branch or snapshot of the production database so you
> can restore instantly if anything goes wrong. Do not proceed without a
> restore point.

In the Neon console: open the project, go to **Branches**, and create a branch
from the current production branch (or take a snapshot/restore point). Note the
branch/snapshot name in your incident log. Rollback = restore this
branch/snapshot; existing tables are never modified by the script and
`migrate deploy` runs in a transaction, so restoring returns production to its
exact prior state.

### 2. Add the `DIRECT_DATABASE_URL` repository secret

The workflow reads the Neon **DIRECT (non-pooled)** connection string from a
GitHub Actions secret. A human must add it (Claude does not handle credentials):

1. Go to the repository **Settings -> Secrets and variables -> Actions**.
2. Select the **Secrets** tab and click **New repository secret**.
3. Name: `DIRECT_DATABASE_URL`
4. Value: the Neon **direct/unpooled** connection string
   (the host does **not** contain `-pooler`). Do not use the pooled endpoint.
5. Click **Add secret**.

The secret is masked in all workflow logs and is only exposed to the recovery
step as an environment variable -- it is never echoed.

### 3. Run the manual workflow

1. Go to the **Actions** tab.
2. In the left sidebar select **Prisma Baseline Recovery (manual)**.
3. Click **Run workflow**.
4. Choose branch `recovery/prisma-baseline-migrate` (or `main` once merged).
5. In the **confirm** input, type this text **exactly**:

   ```
   I understand this will modify production database schema
   ```

6. Click **Run workflow**.

If the confirmation text does not match exactly, the first step fails and no
database change is attempted. On success the workflow runs the preflight checks,
marks the two baseline migrations as applied, deploys the Work OS migration, and
prints `prisma migrate status`.

### 4. Verify afterward

- The workflow run is green and the final **Print migration status** step shows
  all migrations applied with **no pending migrations** and no drift.
- Optionally run the checks in `## Verifying success` above against the database
  (seven Work OS tables exist, indexes/FKs present, tables selectable).
- Confirm the application no longer crashes querying `work_stages`.
- If anything failed: restore the Neon branch/snapshot from step 1. Because the
  script is guarded by `set -euo pipefail` and preflight aborts, a partial run
  leaves existing data untouched; restoring the snapshot is the clean rollback.

> This workflow is a one-off. Once baseline recovery has succeeded and
> `migrate status` is clean in production, it does not need to run again.
