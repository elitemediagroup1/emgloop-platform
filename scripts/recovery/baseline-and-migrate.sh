#!/usr/bin/env bash
# =============================================================================
# EMG Loop — Prisma Migrate baseline + Work OS recovery (ONE-OFF)
# -----------------------------------------------------------------------------
# Purpose:
#   Transition the existing (brownfield) production database into Prisma Migrate
#   management WITHOUT losing data and WITHOUT introducing drift, then apply the
#   Work OS migration.
#
# How it works:
#   The two pre-Work-OS migrations already exist in git and already describe the
#   current production schema:
#       20250624000000_sprint_4_real_data_layer
#       20250626000000_sprint_11_provider_category_ingestion_analytics
#   We mark BOTH as already-applied (prisma migrate resolve --applied), which
#   lets Prisma create _prisma_migrations and record REAL checksums for them
#   WITHOUT re-running their SQL. Then 'prisma migrate deploy' applies only the
#   remaining unapplied migration — the Work OS migration — creating the seven
#   Work OS tables.
#
# This script GENERATES NOTHING. No baseline is synthesized. It only consumes
# migrations already committed to the repository.
#
# Execution context:
#   Run this MANUALLY from CI or a one-off deploy job. It is intentionally NOT
#   wired into the Netlify build. See docs/runbooks/prisma-baseline-recovery.md.
# =============================================================================
set -euo pipefail

SCHEMA="packages/database/prisma/schema.prisma"
MIGRATIONS_DIR="packages/database/prisma/migrations"

BASELINE_1="20250624000000_sprint_4_real_data_layer"
BASELINE_2="20250626000000_sprint_11_provider_category_ingestion_analytics"
WORK_OS="20260707000000_pr75_work_os_blueprint_runtime_v1"

# ---- Required env vars ------------------------------------------------------
# DIRECT_DATABASE_URL must be the Neon DIRECT (non-pooled) connection string.
# Migrations must never run over the pooled endpoint.
: "${DIRECT_DATABASE_URL:?FATAL: DIRECT_DATABASE_URL (non-pooled Neon connection) is required}"

# SHADOW_DATABASE_URL is optional. resolve/deploy do not need a shadow DB, but
# if your environment forbids Prisma's default shadow behavior for any reason,
# provide one. It is echoed only as present/absent, never printed.
if [ -n "${SHADOW_DATABASE_URL:-}" ]; then
  echo "SHADOW_DATABASE_URL: present"
else
  echo "SHADOW_DATABASE_URL: not set (not required for resolve/deploy)"
fi

# ---- Guard 1: all three expected migration folders must exist ---------------
for m in "$BASELINE_1" "$BASELINE_2" "$WORK_OS"; do
  if [ ! -f "$MIGRATIONS_DIR/$m/migration.sql" ]; then
    echo "FATAL: expected migration missing: $MIGRATIONS_DIR/$m/migration.sql" >&2
    exit 1
  fi
done
echo "Guard OK: all three expected migration folders are present."

# ---- Guard 2: baseline migrations must NOT contain Work OS tables -----------
# Protects against ever baselining the Work OS schema by mistake.
if grep -REl 'CREATE TABLE.*(blueprints|blueprint_stages|work_instances|work_stages|work_assignments|work_notifications|work_comments)' \
     "$MIGRATIONS_DIR/$BASELINE_1" "$MIGRATIONS_DIR/$BASELINE_2" >/dev/null 2>&1; then
  echo "FATAL: a baseline migration contains Work OS tables. Wrong baseline. Aborting." >&2
  exit 1
fi
echo "Guard OK: baseline migrations are free of Work OS tables."

# ---- Guard 3: production preflight (read-only) ------------------------------
# Aborts if _prisma_migrations already exists or any Work OS table exists.
psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/recovery/preflight-checks.sql
echo "Guard OK: production preflight passed."

# ---- Use the direct connection for all Prisma operations --------------------
export DATABASE_URL="$DIRECT_DATABASE_URL"
export DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL"

# ---- Step 1: baseline — mark existing migrations as already applied ----------
# Prisma computes and stores the REAL checksums. No fabrication, no fake values.
echo "==> Marking $BASELINE_1 as applied"
npx prisma migrate resolve --applied "$BASELINE_1" --schema "$SCHEMA"

echo "==> Marking $BASELINE_2 as applied"
npx prisma migrate resolve --applied "$BASELINE_2" --schema "$SCHEMA"

# ---- Step 2: deploy — applies ONLY unapplied migrations (Work OS) ------------
echo "==> Deploying unapplied migrations (expected: Work OS only)"
npx prisma migrate deploy --schema "$SCHEMA"

# ---- Step 3: verify ---------------------------------------------------------
echo "==> Migration status"
npx prisma migrate status --schema "$SCHEMA"

echo "Recovery complete. Expected: 'Database schema is up to date', no drift."
