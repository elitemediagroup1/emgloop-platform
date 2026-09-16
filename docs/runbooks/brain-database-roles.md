# Runbook: Brain restricted database roles

**Status (2026-09-17): prepared in B4, NOT applied anywhere shared.** It was verified only on a
disposable local PostgreSQL 18. Apply it only in an environment that is building Brain execution
(staging first, B6), after the B4 migration is deployed there. **Do not apply it to production until
Brain execution is approved for production.**

- **Design:** `docs/architecture/brain-execution-infrastructure.md` §12.
- **Persistence:** `docs/architecture/brain-persistence.md` §11.
- **Script:** `scripts/operations/brain-database-roles.sql`.
- **Checks:** `scripts/operations/brain-database-roles.verify.sql`.

## What it creates

| Role | Component | May | May not |
|---|---|---|---|
| `loop_brain_worker` | the step runner | Read Brain tables, stored controls, `ai_invocations`, `organizations(id, timezone)`. Insert transitions, steps, waits, events, commands, ledger rows. Update only a job's mutable columns (state, execution class for promotion, lease, cancel request, open question, result pointers, times), a step's attempt and checkpoint columns, a wait's status/close columns, the ledger's reconcile columns. | Create a job; record a reply; delete or truncate anything; read or write any product table; change a job's identity, principal, organization, task, capability route, result type, owner, subject, input or idempotency key; write a stored control. |
| `loop_brain_dispatcher` | the dispatcher | Read commands, jobs, waits and stored controls; record a dispatch. | Anything else. |
| `loop_brain_sweeper` | the sweeper | Read commands, jobs, waits and stored controls. | Write anything. |

**Role attributes.**
- Each role is `LOGIN` and nothing more: no superuser, create-database, create-role, replication or
  bypass-RLS.
- **Connection limits:** worker 60, dispatcher 20, sweeper 5.
- **Timeouts:** `statement_timeout = 30s` and `idle_in_transaction_session_timeout = 60s`.

## Steps

1. **Check the target.** This is the environment you intend, and the B4 migration is applied there:
   `npx prisma migrate status` against its direct URL shows 36 applied and nothing pending.
2. **Create the roles with SQL, never in the Neon console.** Console- and API-created roles receive
   `neon_superuser`. Run, as the database owner, against the **direct** (non-pooled) URL:

   ```sh
   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/operations/brain-database-roles.sql
   ```

   The script is idempotent: it revokes everything these roles hold, then grants its list. Re-running
   it is the way to change grants.
3. **Set each password interactively,** so no secret ever sits in a file, a command line or a log:

   ```
   psql "$DIRECT_DATABASE_URL"
   \password loop_brain_worker
   \password loop_brain_dispatcher
   \password loop_brain_sweeper
   ```

   Store each one only in that environment's secret store for its component (Secrets Manager in B6).
   Never paste one into chat, a ticket, GitHub or Netlify.
4. **Verify.** Every row must show `ok = t`:

   ```sh
   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/operations/brain-database-roles.verify.sql
   ```

5. **Connect components through the pooled endpoint** with their own role. The web tier keeps its
   existing connection. Migrations keep using the owner through the manual workflow.

## After a schema change

A later migration that adds a Brain column or table does not grant anything to these roles. Re-run
step 2 (after updating the script in a reviewed PR) and step 4.

## Removing a role

```sql
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM loop_brain_sweeper;
REVOKE USAGE ON SCHEMA public FROM loop_brain_sweeper;
DROP ROLE loop_brain_sweeper;
```

Rotate a password the same way it was set (`\password`), then update the component's secret.

## Evidence (B4, local PostgreSQL 18 only)

- **Applied twice, and idempotent.** The verify script reports 38 of 38 checks ok.
- **`packages/database/test/brain-database-roles.postgres.test.ts`** (opt-in, localhost only) logs in
  as each role with throwaway passwords.
- **Roles doing their jobs through the real repositories:**
  - the sweeper finds a lost command;
  - the dispatcher records its hand-over;
  - the worker starts the job, takes the lease, runs a paid step with its ledger row, checkpoints it,
    opens a question, expires it, and records a policy stop.
- **What the database refused:**
  - the worker changing a job's capability route, result type, owner, subject, principal, task or
    input;
  - the worker creating a job, recording a reply, deleting an event, writing a control, or reading
    `users` or `customers`;
  - the sweeper writing anything;
  - the dispatcher and sweeper reading the ledger.
