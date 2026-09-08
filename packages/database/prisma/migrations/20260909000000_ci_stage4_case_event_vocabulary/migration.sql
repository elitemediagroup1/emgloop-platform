-- Stage 4 -- give ten investigation events a governed type of their own.
--
-- WHAT IS WRONG TODAY. Ten distinct Stage 4 meanings are recorded on two
-- generic observation types. "Loop recorded a finding", "a person selected one
-- of Loop's options", "somebody was released from this investigation" and seven
-- others are all NOTE_ADDED rows, or (for authorization) REVIEWED rows,
-- distinguished only by an exact English paragraph stored in `reason`.
--
-- WHY THAT IS NOT MERELY UNTIDY. `reason` is prose written for a person reading
-- a timeline. Nothing stops somebody fixing a typo in it, rewording it for
-- clarity, or translating it -- and the moment they do, every predicate
-- comparing that paragraph silently stops matching, the history stops being
-- readable, and no test fails, because the sentence is still perfectly correct
-- English. Behaviour must depend on governed values, never on wording.
--
-- WHAT THIS ADDS. Ten values on the existing `OperationalObservationType` enum.
-- Nothing else: no table, no column, no constraint, no index.
--
-- ADDITIVE IN THE STRICTEST SENSE.
--   * No existing enum value is renamed, reordered or removed. Postgres cannot
--     reorder an enum without recreating the type and rewriting every column
--     that uses it; appending avoids that entirely, and nothing in this schema
--     sorts by this enum -- `operational_observations` is ordered by `sequence`.
--   * No row is updated. Not one. Every observation already in the database
--     keeps the type and the reason it was written with.
--   * No default changes. `observation_type` has no default and never had one.
--   * No backfill. A backfill here would be forging history: it would rewrite
--     rows to claim they were recorded with a vocabulary that did not exist when
--     they were written, and the claim would be false.
--
-- HOW OLD ROWS STAY READABLE. `packages/shared/src/case-observation.ts` holds
-- one table of the pre-migration (type, reason) pairs and one function that
-- checks the typed member first and that table second. It is marked legacy in
-- exactly one place, so when no observation predates this migration -- one
-- query on `created_at` answers that -- the table and the fallback delete
-- together and every caller keeps working.
--
-- TENANCY. Enum values are schema-level and carry no tenant meaning. Every row
-- that will use them is written through `operational_observations`, which is
-- organization-scoped and reached only through the Decision Engine.
--
-- TRANSACTION SAFETY. Prisma runs a migration inside a transaction. Postgres 12+
-- permits ALTER TYPE ... ADD VALUE inside one provided the new value is not used
-- in the same transaction; this migration only declares the values and writes no
-- rows, so it is safe. IF NOT EXISTS makes each statement idempotent, so a
-- partially applied run can be repeated.
--
-- NOT APPLIED IN PRODUCTION. Migrations reach production only through the manual
-- `Deploy Prisma Migrations` workflow_dispatch. Until somebody runs it, a build
-- emitting one of these values would fail against the live enum -- so this
-- migration must be deployed BEFORE the code in this PR is deployed.

ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'INVESTIGATION_AUTHORIZED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'FINDING_RECORDED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'FINDING_SUPERSEDED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'RECOMMENDATION_RECORDED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'RECOMMENDATION_SELECTED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'RECOMMENDATION_DISMISSED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'RECOMMENDATION_REVISED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'PARTICIPANT_ADDED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'PARTICIPANT_CHANGED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'PARTICIPANT_RELEASED';
