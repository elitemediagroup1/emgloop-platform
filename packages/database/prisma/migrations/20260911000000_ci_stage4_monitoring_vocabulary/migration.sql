-- Stage 4 -- three observation types for monitoring.
--
-- WHY NO TABLE. A monitoring plan is somebody's declaration, made at a moment,
-- correctable afterwards, and its whole value depends on the previous version
-- remaining legible -- a success criterion rewritten after the numbers are in is
-- not a test, it is a rationalisation. That is an append-only log, and the Case
-- already has one. The plan rides on the observation's existing `evidence` JSON
-- payload; a correction is another row, and the history is the sequence.
--
-- A `case_monitoring` TABLE WOULD HAVE BEEN A SECOND CASE HISTORY. It would need
-- its own ordering, its own supersession, its own tenant scope and its own
-- answer to "what did this say in March", all of which
-- `operational_observations` already has and already gets right.
--
-- WHY NOT A NEW LIFECYCLE. `OperationalPriorityState.WATCHING` already means
-- "somebody is waiting to see whether this holds", and `REOPENED` already clears
-- `resolvedAt` and increments `reopenCount`. Monitoring is WATCHING and
-- re-engagement is REOPENED. A second lifecycle beside them would be two answers
-- to "is this open".
--
-- ADDITIVE IN THE STRICTEST SENSE. Three enum values appended. No table, no
-- column, no constraint, no index, no row updated, no default, no backfill. No
-- existing value renamed or reordered -- Postgres cannot reorder an enum without
-- recreating the type, and nothing sorts by this one.
--
-- TRANSACTION SAFETY. Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a
-- transaction provided the value is not used in the same one; this declares
-- values and writes no rows. IF NOT EXISTS makes each statement repeatable.
--
-- ORDER. Applies AFTER 20260909000000 (which added the Stage 4 event
-- vocabulary) and after 20260910000000. NOT APPLIED IN PRODUCTION, and must be
-- deployed BEFORE the code that emits these values.

ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'MONITORING_STARTED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'MONITORING_REVISED';
ALTER TYPE "OperationalObservationType" ADD VALUE IF NOT EXISTS 'MONITORING_CONCLUDED';
