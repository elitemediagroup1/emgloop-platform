# Brain durable persistence (B4)

**Status (2026-09-17): built in B4; migration `20260919000000_brain_durable_persistence` NOT dispatched.**
- **Built:**
  - the tables below;
  - their repositories in `packages/database/src/repositories/brain/`;
  - the pure contracts they rely on (`brain-wait.ts`, `ai-controls.ts`, `brainCommandDedupeKey`);
  - a Brain-events Activity adapter (not yet composed into the live feed);
  - the restricted-roles operations script and runbook.
- **Not wired to anything:**
  - no API, executor, doorbell, AWS resource or provider call exists;
  - AI stays OFF;
  - the tables stay empty after the migration.
- **Where it sits:**
  - `brain-execution-architecture.md` holds the direction and contracts;
  - `brain-execution-infrastructure.md` holds the AWS design this persistence serves (§6, §8, §11, §12, §14, §17, §25);
  - this record says what is stored and how it is protected, and carries the migration dossier (§12).

## 1. The rule this layer exists for

**Neon is the only authority for Brain work.** An accepted job, its history, its steps and checkpoints,
the questions it asks, the commands that move it and the events it reports are rows. An executor
holds a reference (`jobId`, `generation`) and nothing else.
- **Nothing depends on the submitter staying connected.** No row describes a browser, a session or a
  connection. A durable job therefore survives a closed tab, a logout, a lost network or a long wait.
- **Every state change is decided by the pure contracts.** They are `brainJobTransition`,
  `brainSubmissionDecision`, `brainWaitReplyDecision`, `brainLeaseDecision`,
  `brainStepResumeDecision` and `aiControlAppendDecision`.
- **Each decision is written by one write path** that records the job, its transition, its event
  and anything it closes, together or not at all.

## 2. Tables

All vocabularies are **text** validated by `@emgloop/shared`, never Postgres enums, so adding a result
type, route or owner is a reviewed contract change, not a migration (DRAFT was added this way). CHECK
constraints pin only what is structural.

| Table | What a row is | Keys that make it safe |
|---|---|---|
| `brain_jobs` | One piece of accepted work | PK `id`; unique `(organizationId, id)` for composite references; unique `(organizationId, principalUserId, taskId, idempotencyKey)`; FK `(principalUserId, organizationId)` → `organization_memberships(userId, organizationId)` NO ACTION; FK `(organizationId, resumesJobId)` → itself NO ACTION |
| `brain_job_transitions` | One state change, in order | unique `(jobId, sequence)`; FK `(organizationId, jobId)` → `brain_jobs` CASCADE |
| `brain_job_steps` | One step, its attempts and its sealed checkpoint | unique `(jobId, stepKey)`; composite job FK |
| `brain_job_waits` | One question and the one reply it accepted | unique `(organizationId, openJobKey)` (the job id while OPEN, else NULL); unique `(organizationId, id)`; composite job FK; FK `(principalUserId, organizationId)` → memberships NO ACTION |
| `brain_commands` | START, RESUME or CANCEL | unique `(organizationId, dedupeKey)`; composite job FK; FK `(organizationId, waitId)` → waits |
| `brain_events` | An allowlisted `BrainJobEvent` | PK `id` = `brainEventId(jobId, sequence)`; unique `(jobId, sequence)`; composite job FK |
| `ai_controls` | One version of one stored control | unique `(controlKey, version)` |
| `ai_control_current` | The current version of each control | PK `controlKey`; FK `(controlKey, version)` → `ai_controls` |

Every table also has a plain FK to `organizations` (CASCADE). Actor and responder user references are
FKs to `users` with SET NULL (attribution only). A deleted person then reads as an empty id, which
matches nobody.

**`brain_jobs` columns, grouped.** The four declarations are separate columns that nothing collapses:

| Declaration | Columns | Changes? |
|---|---|---|
| What the work needs | `capabilityRoute` | never |
| What it produces, who holds it, about what | `resultType`, `resultOwnerAuthority`, `resultSubjectType`, `resultSubjectId` | never |
| How it runs | `executionClass`, `promotedAt` | only by promotion, once, INTERACTIVE → DURABLE |

The rest of the row:
- **identity:** organization, principal, task id and version, `generation`;
- **concurrency:** `version`, `lastSequence`, `leaseHolder`, `leaseExpiresAt`;
- **state:** `state`, `endReason`, and the cancel request (`cancelRequestedAt`, actor kind, user and
  policy, `cancelReason`);
- **the open question:** `currentWaitId`, `currentWaitExpiresAt`;
- **pointers:** `resultRefs` (pointers only);
- **submission:** `input` (the submission's scalar task parameters), `idempotencyKey`,
  `submissionFingerprint` (SHA-256), `resumesJobId`;
- **time:** `acceptedAt`, `startedAt`, `endedAt`, `activeElapsedMs`.

**There is no provider, model, fallback or routing column on any Brain table.** Routing chooses per
call, and each call records its choice on `ai_invocations`.

**CHECK constraints (hand-written; Prisma cannot express them).**
- **`brain_jobs_shape`:**
  - known state and execution class;
  - an open question exactly while `WAITING_FOR_USER`, and only on a durable job;
  - promoted only if durable;
  - a lease is a holder and an expiry together;
  - a cancel request is complete or absent;
  - exactly the terminal states have `endedAt`;
  - exactly FAILED/CANCELLED have an `endReason`;
  - an ended job holds no lease;
  - exactly a SUCCEEDED job has result pointers;
  - a SHA-256 fingerprint;
  - non-blank declarations.
- **`brain_job_transitions_shape`:**
  - sequence 1 is `ACCEPTED`, and only it has no `fromState`;
  - known kinds, states and actor shape.
- **`brain_job_steps_shape`:**
  - a plan-shaped step key;
  - `paidAttempts ≤ attempts`;
  - exactly a SUCCEEDED step carries a complete, non-empty sealed checkpoint whose size matches.
- **`brain_job_waits_shape`:**
  - the open key is held exactly while OPEN and equals the job id;
  - exactly an ANSWERED wait has a reply, fingerprint and time;
  - the responder can only be the principal;
  - expiry after request;
  - the question is an object.
- **`brain_commands_shape`:**
  - `dedupeKey` equals what `brainCommandDedupeKey` derives;
  - only RESUME names a wait;
  - dispatch count and stamps agree;
  - issuer shape.
- **`brain_events_shape`:**
  - `id` = `jobId#sequence`;
  - approved event names only;
  - only a success has result pointers;
  - actor shape.
- **`ai_controls_shape` and `ai_control_current_shape`:**
  - `controlKey` derived from the target;
  - a coherent target per scope; an ORGANIZATION control's value is its own organization;
  - a non-blank reason;
  - actor HUMAN or OPERATIONS only.
- **`ai_invocations_brain_call`:**
  - `brainJobId` and `brainStepKey` together or not at all;
  - `invocationId` starts with `jobId:stepKey:` (`brainCallKey`).

## 3. How a job changes

`applyBrainJobTransition` is the one write path (`brain-job-writes.ts`). Inside the caller's
transaction it:
1. reads the job **in the organization**;
2. checks the version and lease the writer claims;
3. asks `brainJobTransition` for the decision;
4. turns the decision into column changes with `brainJobChanges`, which **throws** if the decision
   moved the job's identity, principal, task, capability route, result type, owner, subject or
   resume link. Promotion may change only the execution class (and stamp `promotedAt`), and a cancel
   request is recorded once;
5. updates the job **conditionally on the version it read**, so a second writer changes nothing and
   gets `VERSION_CONFLICT`;
6. appends the transition (`sequence = lastSequence + 1`);
7. closes a question the job is no longer waiting on;
8. appends the event when the contract emits one.

A decision that changes nothing (a second cancel request) writes nothing.

**Acceptance** (`BrainJobRepository.accept`) writes the job, transition 1, `brain.job.accepted` (event
`jobId#1`) and the START command in one transaction. It does not authorize: the Brain API decides
whether this person may start this task (B5). It does refuse:
- a submission that carries authority;
- an unknown capability route;
- an ownership pairing the table does not allow;
- a subject the owner does not hold, or an execution class the task does not support;
- a principal without an ACTIVE membership in the organization;
- a resumed job that is not a failed or cancelled job of the same task **in the same organization**;
- a different request under a used idempotency key.

The same request returns the job it created. Two simultaneous identical requests are settled by the
unique index (proven on Postgres with 12 concurrent writers).

**Cancellation** (`requestCancel`):
- **Idle work stops at once:** ACCEPTED, QUEUED and WAITING_FOR_USER jobs are cancelled immediately,
  and an open question is CLOSED with them.
- **Running work records the request** and stops at its next boundary (`CANCEL_SETTLED`). A result that
  arrives meanwhile is refused (`CANCEL_PENDING`).
- **One command:** one CANCEL command per generation is stored either way, and the first request stands.

**Leases** (`lease`, `releaseLease`) apply `brainLeaseDecision` with a version-conditional write:
- one holder at a time;
- an expired lease is taken over;
- a stale generation is refused;
- an ended job holds none.

`addActiveTime` accumulates executing time for the lease holder only.

## 4. Steps, checkpoints and resumption

- **What `resumeState` returns.** It gives `brainStepResumeDecision` exactly what it needs:
  - whether a checkpoint exists for this step key and input fingerprint;
  - attempts and paid attempts made;
  - this step's reserved-but-unreconciled ledger call keys (`ai_invocations` rows with this
    `brainJobId` and `brainStepKey` still `IN_FLIGHT`).

  A lost paid call therefore counts as spent. With both paid attempts used, the decision is
  `PROVIDER_RESULT_LOST` (tested).
- **One attempt at a time.** `beginAttempt(N)` is conditional on N−1 attempts and no checkpoint, so
  two workers cannot start the same attempt, and a finished step never starts again. Steps run only
  in a RUNNING job.
- **A step keeps its input.** Ledger call keys are `(job, step, attempt)`, so one step key has one
  attempt sequence. A different input fingerprint under the same key is refused
  (`STEP_INPUT_CHANGED`): it is never re-run and never answered from another input's checkpoint. A
  plan that needs a different input needs a different step key.
- **Checkpoints are sealed.**
  - `recordCheckpoint` stores ciphertext plus its key reference and seal version.
  - `brainSealedPayloadRefusals` refuses empty, oversized (> 1 MiB), unlabelled or readable payloads
    (anything that decodes as text or JSON).
  - Sealing is the executor's (`BrainPayloadSealer`, bound to organization, job, step, input and
    purpose). It is implemented with the execution environment's key service later; B4 has only a
    test double.
  - Recording twice keeps the first checkpoint.
- **Resumed work reuses what was paid for.** A job that resumes a failed one finds that job's
  checkpoint for the same step and input, in the same organization only (up to eight links back).
- **Failures are codes.** `recordFailure` stores Loop's failure class, never a provider's text.

## 5. Commands, events and Activity

- **Commands** are written only with the change they accompany (acceptance, a reply, a cancel), by
  `storeBrainCommand`. It uses an insert with ON CONFLICT DO NOTHING under `brainCommandDedupeKey`,
  then reads back what is stored, so a duplicate never aborts a transaction.
  - `markDispatched` keeps the first dispatch time and counts every hand-over.
  - The sweeper's scan finds commands never handed over.
- **Events** are the `BrainJobEvent` allowlist and nothing else:
  - they are checked by `brainJobEventRefusals` before insert;
  - their id is derived from the transition;
  - no summary, claim or model text.
- **Activity.**
  - **Shape.** `BrainEventActivityAdapter` projects events as `STATE_CHANGE` items: `RECORDED`,
    `NOT_APPLICABLE` identity, the task's own `requires`, and no content. Events for a task this
    deployment does not know are not shown.
  - **Ownership.** Activity points at work and never holds or names a result; the owner shows the
    result under its own guard.
  - **Not composed into the live feed in B4:** the table does not exist in production until this
    migration is deployed. Composing it is a B5 step, and a test holds that.

## 6. WAITING_FOR_USER

- **Open (`open`).** Only a RUNNING, durable job of a task that may wait can open a question, with an
  expiry in the future.
  - The job becomes `WAITING_FOR_USER` in the same transaction that stores the question.
  - Nothing runs or bills while it waits.
- **Answer (`answer`).**
  - `brainWaitReplyDecision` decides: only the principal, one accepted reply, and a refusal named for
    a late or closed question.
  - A stranger learns nothing about the wait's state.
  - The reply is stored with a write conditional on the wait still being OPEN, beside one RESUME
    command.
  - The same reply again returns what was recorded; a different one is `WAIT_ALREADY_ANSWERED`.
  - Recording a reply does **not** move the job.
- **Resume (`resume`).** The executor re-decides the principal's access and passes
  `responderPermitted`. The job moves back to RUNNING, and the reply is read from Loop, never carried
  in a message.
- **Expire (`expire`).** Only once the time has passed: the job is CANCELLED `WAIT_EXPIRED`, the wait is
  EXPIRED, and a late reply is refused.

## 7. Stored AI controls

- **Recorded authority, not configuration.** Nothing here reads or copies an environment variable.
  - Each deployment's environment (`LOOP_AI_*`, the worker's switch) stays the **floor**.
  - A stored control is the recorded decision: who, when, why, about what.
  - **B5's reader combines them:** work runs only where both allow, and any KILLED control stops it.
    Absence means OFF.
- **Who records what.**
  - `recordOrganizationControl`: a person who is an ACTIVE member records ORGANIZATION (its value is
    always that organization) or a TASK within it. Which roles may do so (OWNER/ADMIN) is B5's IAM
    check.
  - `recordPlatformControl`: GLOBAL, PROVIDER, MODEL or a platform-wide TASK, by a reviewed operations
    run (actor `OPERATIONS` with a reference). No product path calls it.
- **Append-only and versioned.** A writer names the version it read. A stale writer is refused, and
  recording the current state appends nothing. The log row and the current view are written together,
  and the view's FK points at its log row.
- **Visibility.** `currentFor(org)` returns platform controls and that organization's own, never
  another's.

## 8. The `ai_invocations` extension

- **Three nullable columns:**
  - `brainJobId` and `brainStepKey`, with a composite FK to the job in the same organization and the
    call-key CHECK;
  - `specializationPolicyVersion`.
- **Reservations may carry them.** `AiUsageLedgerRepository.reserve` accepts them as optional inputs.
  The existing, switched-off Netlify gateway does not pass them, and its rows keep NULL.
- **Unchanged:** `profile` keeps holding the capability route, and there is still no prompt or
  response column.
- **The insert now returns only its id.** Code deployed ahead of this migration therefore cannot fail
  on the new columns (a fence test holds this).

## 9. How organization isolation is enforced

1. **In the database:**
   - composite FKs tie every child row to a job in the same organization;
   - the principal must hold a membership in that organization;
   - a resumed job and a ledger row's job must be in the same organization.
2. **In every repository method:** the organization is the first argument and is in every `where`. A
   record in another organization is **not found**, never "forbidden". A fence test scans the
   repositories for unscoped reads and writes.
3. **The one deliberate exception is `BrainExecutionReferences`.** An executor is given only a command
   id (doorbell) or a job id and generation (advance message), by design, so its first read finds the
   organization from the record.
   - It returns identities only (organization, id, job, generation) and never writes.
   - The sweeper's scans live there too.
   - A fence test holds both rules.
4. **In the restricted roles** (§11): the worker cannot read a product table or change what a job is.

## 10. Decisions made while building B4 (for review)

| Decision | Why |
|---|---|
| `brain_jobs.input` (the submission's scalar task parameters) | The executor obligation `REFERENCES_ONLY` says input is read from Loop's records at each step, so a job cannot run from Neon without it. Scalars only, authority keys refused. Its retention follows the open "execution data" retention decision. |
| `brain_jobs.resultRefs` and `lastSequence` | The approved `BrainJobSnapshot` carries result pointers; the event id needs the transition sequence. |
| One `resultSubjectType` column | The ownership table fixes the owner's subject type to the job's subject type, so the two can never differ. |
| One row per step key | Ledger call keys omit the input fingerprint, so a changed input under one key is refused (`STEP_INPUT_CHANGED`). |
| NO ACTION on principal and ledger job keys | A person cannot be deleted from under their jobs, and a spend row cannot lose its job. Deleting an organization still cascades everything (tested). |
| Wait statuses OPEN / ANSWERED / EXPIRED / CLOSED | CLOSED = the job stopped or failed while waiting. |
| Column-level UPDATE grants for the worker (§11) | The database, not only the repository, refuses a change to what a job is. |
| Activity adapter not composed yet | A feed that reads a table the production database does not have yet would fail every organization-wide read. |

## 11. Restricted database roles

- **The roles.** `loop_brain_worker`, `loop_brain_dispatcher` and `loop_brain_sweeper` are created
  and granted by the reviewed operations script `scripts/operations/brain-database-roles.sql`, never
  by a migration. The steps are in `docs/runbooks/brain-database-roles.md`.
- **The worker:**
  - may read Brain tables, the stored controls, its ledger and `organizations(id, timezone)`;
  - may update only the mutable job, step and wait columns and the ledger's reconcile columns;
  - may insert transitions, steps, waits, events, commands and ledger rows;
  - may **not** create a job, record a reply, delete anything, touch a product table, or change a
    job's identity, principal, task, capability route, result type, owner, subject or input.
- **The dispatcher:** reads commands, jobs, waits and controls, and records dispatches.
- **The sweeper:** read-only.
- **Verified on PostgreSQL 18:** applied twice (idempotent), 38 of 38 privilege checks pass, and an
  opt-in test logs in as each role and drives the real repositories.
- **Not applied to any shared or production database in B4.**

## 12. Migration dossier — `20260919000000_brain_durable_persistence`

**Dispatch is Matt's decision. It has not been dispatched.**

**Statement inventory: 65 statements.**
- **Prisma-derived: 56.** They are identical, in order and text after whitespace normalization, to
  `prisma migrate diff --from-schema-datamodel <main 5d73d46> --to-schema-datamodel <this branch> --script`:

  | Statement | Count | Detail |
  |---|---|---|
  | `ALTER TABLE "ai_invocations" ADD COLUMN` | 1 | Three nullable TEXT columns, no default |
  | `CREATE TABLE` | 8 | |
  | `CREATE INDEX` | 13 | One of them on `ai_invocations` |
  | `CREATE UNIQUE INDEX` | 9 | |
  | `ADD FOREIGN KEY` | 25 | See the targets below |

  The 25 foreign keys reference:
  - `organizations`: 8;
  - `users`: 6;
  - `organization_memberships`: 2, which use its existing unique `(userId, organizationId)`;
  - `brain_jobs`: 7, including one from `ai_invocations`;
  - `brain_job_waits`: 1;
  - `ai_controls`: 1.
- **Hand-written: 9 `ADD CONSTRAINT … CHECK`,** one per new table plus `ai_invocations_brain_call`.
- **Never present:**
  - DROP, TRUNCATE, RENAME, or ALTER COLUMN;
  - UPDATE, DELETE, INSERT or SELECT;
  - enum creation, backfill, or legacy conversion.
- **ASCII only.**
- **Existing tables touched:**
  - `ai_invocations`: one column addition, one index, one FK, one CHECK;
  - `organizations`, `users` and `organization_memberships` only as FK targets.

**Verification without production.**
- `prisma validate` passes.
- **A fresh PostgreSQL 18 replays all 36 migrations.**
  - `prisma migrate diff --from-url <replayed db> --to-schema-datamodel` reports "No difference
    detected" (exit 0).
  - `--from-migrations --to-schema-datamodel` with a shadow database reports the same (exit 0).
  - Prisma does not model CHECK constraints, so the hand-written ones cause no drift.

**Locks and duration.**
- **New tables and indexes** lock nothing existing and are instantaneous.
- **On `ai_invocations`:**
  - `ADD COLUMN` (nullable, no default) is a catalogue change under a brief ACCESS EXCLUSIVE lock;
  - `CREATE INDEX` takes a SHARE lock while it builds;
  - the CHECK scans the table under ACCESS EXCLUSIVE;
  - the table has no rows in production (AI has never been activated), so all three complete in
    milliseconds.
- **Foreign keys** take SHARE ROW EXCLUSIVE on `organizations`, `users` and
  `organization_memberships` while validating new, empty tables. This is the only point where the
  migration enters those tables' lock queues, and it is momentary.
- **Prisma runs the whole file in one transaction.** If any statement fails, nothing is applied.

**Code and migration order.**
- **Deploying the code before the migration is safe:**
  - no product path reads or writes the new tables;
  - the Activity adapter is not composed;
  - the one changed insert (`ai_invocations`) returns only its id, and AI is OFF.
- **The migration before the code is also safe:** the tables are additive and the new columns
  nullable.

**Before dispatching.**
1. **Confirm the PR is merged and on `main`.** `git fetch origin && git diff --stat origin/main
   <merged head>` must be empty. The workflow deploys the ref it is dispatched from, so dispatch from
   `main`.
2. **Confirm nothing else is pending.** `gh run list --workflow="Deploy Prisma Migrations" --limit 3`:
   - the last successful run is still `35103219698` (35 migrations);
   - no other migration is pending on `main`;
   - `ls packages/database/prisma/migrations | grep -c '^2'` on `main` is **36**.

**Dispatch.** Actions → *Deploy Prisma Migrations* → *Run workflow* on `main`, or
`gh workflow run "Deploy Prisma Migrations" --ref main`.

**The run log must show:**
- `36 migrations found in prisma/migrations`;
- `Applying migration 20260919000000_brain_durable_persistence`;
- `All migrations have been successfully applied.`;
- in the status step, `Database schema is up to date!` with no failed or rolled-back migration.

**Expected production migration count after the run: 36.**

**After it runs.** Optional, read-only, by a person with production read access; this record
performs none of it.
- `_prisma_migrations` has 36 finished rows and 0 rolled back.
- The eight new tables exist and hold **0 rows**.
- `ai_invocations` has the three new columns, all NULL.

Nothing in the product writes the new tables until B5, and no Brain role exists until the runbook is
applied in an environment that is building Brain execution.

**Rollback.**
- **No down migration.** Prisma has none, and the change is additive and unwritten, so leaving it in
  place is harmless.
- **Removing it** would be a new, reviewed forward migration that drops the eight tables and the
  three columns with their index and constraints.
- **Never** hand-edit `_prisma_migrations`.

## 13. What B5 builds on this

- **APIs.** The Brain API (submit, status, respond, cancel) and the internal Brain API (access,
  context, commit) call these repositories.
- **Stored controls.** The stored-control reader combines `currentFor` with each deployment's floor.
- **Activity.** The Brain-events adapter is composed into Activity after this migration is
  deployed.
- **Sealing.** A real `BrainPayloadSealer` (local development key; the execution environment's key
  service in B6).
- **The in-process step runner** drives jobs through `lease` → `resumeState`/`beginAttempt` →
  `recordCheckpoint` → `transition`.
- **The old route.** `/api/brain/call-handling-briefing` is retired.
