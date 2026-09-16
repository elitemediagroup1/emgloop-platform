-- Brain restricted database roles: the checks the runbook asks for (slice B4).
-- Read-only. Every row must say ok = true.
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/operations/brain-database-roles.verify.sql

WITH expectations(role, object, privilege, expected) AS (
  VALUES
    -- Nothing but Brain tables and two organization columns.
    ('loop_brain_worker', 'users', 'SELECT', false),
    ('loop_brain_worker', 'customers', 'SELECT', false),
    ('loop_brain_worker', 'conversations', 'SELECT', false),
    ('loop_brain_worker', 'organization_memberships', 'SELECT', false),
    ('loop_brain_worker', 'audit_logs', 'INSERT', false),
    ('loop_brain_worker', 'brain_jobs', 'SELECT', true),
    ('loop_brain_worker', 'brain_jobs', 'INSERT', false),
    ('loop_brain_worker', 'brain_jobs', 'DELETE', false),
    ('loop_brain_worker', 'brain_job_waits', 'DELETE', false),
    ('loop_brain_worker', 'brain_events', 'INSERT', true),
    ('loop_brain_worker', 'brain_events', 'UPDATE', false),
    ('loop_brain_worker', 'brain_job_transitions', 'UPDATE', false),
    ('loop_brain_worker', 'ai_controls', 'INSERT', false),
    ('loop_brain_worker', 'ai_invocations', 'INSERT', true),
    ('loop_brain_worker', 'ai_invocations', 'DELETE', false),
    ('loop_brain_dispatcher', 'brain_commands', 'SELECT', true),
    ('loop_brain_dispatcher', 'brain_commands', 'INSERT', false),
    ('loop_brain_dispatcher', 'brain_jobs', 'UPDATE', false),
    ('loop_brain_dispatcher', 'ai_invocations', 'SELECT', false),
    ('loop_brain_sweeper', 'brain_jobs', 'SELECT', true),
    ('loop_brain_sweeper', 'brain_jobs', 'UPDATE', false),
    ('loop_brain_sweeper', 'brain_commands', 'INSERT', false),
    ('loop_brain_sweeper', 'ai_invocations', 'SELECT', false)
)
SELECT role, object, privilege, expected,
       has_table_privilege(role, object, privilege) AS actual,
       has_table_privilege(role, object, privilege) = expected AS ok
FROM expectations
UNION ALL
SELECT role, 'brain_jobs.' || col, 'UPDATE', expected,
       has_column_privilege(role, 'brain_jobs', col, 'UPDATE'),
       has_column_privilege(role, 'brain_jobs', col, 'UPDATE') = expected
FROM (VALUES
    ('loop_brain_worker', 'executionClass', true),
    ('loop_brain_worker', 'state', true),
    ('loop_brain_worker', 'capabilityRoute', false),
    ('loop_brain_worker', 'resultType', false),
    ('loop_brain_worker', 'resultOwnerAuthority', false),
    ('loop_brain_worker', 'resultSubjectType', false),
    ('loop_brain_worker', 'resultSubjectId', false),
    ('loop_brain_worker', 'principalUserId', false),
    ('loop_brain_worker', 'organizationId', false),
    ('loop_brain_worker', 'taskId', false),
    ('loop_brain_worker', 'input', false),
    ('loop_brain_worker', 'idempotencyKey', false)
  ) AS c(role, col, expected)
UNION ALL
SELECT rolname, 'role attributes', 'NONE', true,
       NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls),
       NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
FROM pg_roles
WHERE rolname IN ('loop_brain_worker', 'loop_brain_dispatcher', 'loop_brain_sweeper')
ORDER BY 1, 2, 3;
