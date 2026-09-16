-- Brain restricted database roles (slice B4). REVIEWED OPERATIONS SCRIPT.
--
-- Runbook: docs/runbooks/brain-database-roles.md. Design:
-- docs/architecture/brain-execution-infrastructure.md section 12.
--
-- WHAT IT DOES. Creates (if absent) three login roles for the Brain execution
-- environment and gives each exactly the table and column privileges its component
-- needs -- nothing on any product table except the two organization columns the usage
-- ledger's business day needs. It is idempotent: it first revokes everything these
-- roles hold on the schema, then grants the list below, so re-running it converges.
--
-- WHAT IT NEVER DOES. It sets no password (the operator sets each one interactively
-- with \password, so no secret is ever in a file, a command line or a log). It grants no
-- DELETE, no TRUNCATE, no DDL, no schema CREATE, and no role attribute beyond LOGIN. It is
-- NOT a Prisma migration: roles differ between environments and a migration must not
-- depend on them. Neon: create these roles with SQL, never in the console, which would
-- give them neon_superuser.
--
-- WHEN. Only after the B4 migration is deployed to the target database, and only in an
-- environment whose Brain execution is being built (staging first). Not in production
-- in B4.
--
-- HOW. psql against the DIRECT (non-pooled) connection string, as the database owner:
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/operations/brain-database-roles.sql

BEGIN;

DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['loop_brain_worker', 'loop_brain_dispatcher', 'loop_brain_sweeper'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', r);
    END IF;
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', r);
    -- A runaway query or an abandoned transaction must not hold Brain rows.
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r, '30s');
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '60s');
  END LOOP;
END
$$;

ALTER ROLE loop_brain_worker CONNECTION LIMIT 60;
ALTER ROLE loop_brain_dispatcher CONNECTION LIMIT 20;
ALTER ROLE loop_brain_sweeper CONNECTION LIMIT 5;

-- Start from nothing, every time.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM loop_brain_worker, loop_brain_dispatcher, loop_brain_sweeper;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM loop_brain_worker, loop_brain_dispatcher, loop_brain_sweeper;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM loop_brain_worker, loop_brain_dispatcher, loop_brain_sweeper;
REVOKE CREATE ON SCHEMA public FROM loop_brain_worker, loop_brain_dispatcher, loop_brain_sweeper;
GRANT USAGE ON SCHEMA public TO loop_brain_worker, loop_brain_dispatcher, loop_brain_sweeper;

-- ================== loop_brain_worker ==================
-- Leases and advances jobs, runs steps, records checkpoints, opens and closes waits,
-- appends history and events, stores a policy CANCEL, and reserves and reconciles its
-- own ledger rows. It never creates a job, never records a reply, and can never change
-- what a job IS: its identity, principal, task, capability route, result type, owner,
-- subject or input are not in its UPDATE list.

GRANT SELECT ON brain_jobs, brain_job_transitions, brain_job_steps, brain_job_waits, brain_commands, brain_events,
  ai_controls, ai_control_current, ai_invocations TO loop_brain_worker;
GRANT SELECT ("id", "timezone") ON organizations TO loop_brain_worker;

GRANT UPDATE ("state", "executionClass", "promotedAt", "version", "lastSequence", "leaseHolder", "leaseExpiresAt",
  "cancelRequestedAt", "cancelActorKind", "cancelActorUserId", "cancelActorPolicy", "cancelReason", "endReason",
  "currentWaitId", "currentWaitExpiresAt", "resultRefs", "startedAt", "endedAt", "activeElapsedMs", "updatedAt")
  ON brain_jobs TO loop_brain_worker;

GRANT INSERT ON brain_job_transitions, brain_events TO loop_brain_worker;

GRANT INSERT ON brain_job_steps TO loop_brain_worker;
GRANT UPDATE ("state", "attempts", "paidAttempts", "lastFailureClass", "checkpointSealed", "checkpointKeyRef",
  "checkpointSealVersion", "checkpointSizeBytes", "checkpointedAt", "startedAt", "endedAt", "updatedAt")
  ON brain_job_steps TO loop_brain_worker;

GRANT INSERT ON brain_job_waits TO loop_brain_worker;
GRANT UPDATE ("status", "openJobKey", "closedAt", "updatedAt") ON brain_job_waits TO loop_brain_worker;

GRANT INSERT ON brain_commands TO loop_brain_worker;

GRANT INSERT ON ai_invocations TO loop_brain_worker;
GRANT UPDATE ("outcome", "servedModel", "providerRequestId", "fellBackFrom", "inputTokens", "outputTokens",
  "cachedInputTokens", "reasoningTokens", "unitCostBasis", "failureClass", "rejectionCodes", "attemptCount",
  "completedAt", "latencyMs", "updatedAt")
  ON ai_invocations TO loop_brain_worker;

-- ================== loop_brain_dispatcher ==================
-- Reads a command and its job, checks the stored controls, and records the hand-over.

GRANT SELECT ON brain_commands, brain_jobs, brain_job_waits, ai_controls, ai_control_current TO loop_brain_dispatcher;
GRANT UPDATE ("dispatchedAt", "lastDispatchedAt", "dispatchCount", "updatedAt") ON brain_commands TO loop_brain_dispatcher;

-- ================== loop_brain_sweeper ==================
-- Finds due work -- lost rings, expired questions, stale leases -- and hands references
-- to the queues. Read-only.

GRANT SELECT ON brain_commands, brain_jobs, brain_job_waits, ai_controls, ai_control_current TO loop_brain_sweeper;

COMMIT;
