-- Brain durable execution: the persistence authority (slice B4).
--
-- ADDITIVE ONLY. Eight new tables; three new NULLABLE columns, one index, one
-- foreign key and one CHECK on "ai_invocations". Zero DROP, zero rename, zero
-- TRUNCATE, zero column-type change, zero UPDATE/DELETE/INSERT, zero backfill, zero
-- legacy conversion. No existing row is read, written or moved by this migration.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this file is deliberately plain ASCII.
--
-- ================== WHAT THIS ADDS ==================
--
-- brain_jobs              one piece of accepted Brain work
-- brain_job_transitions   its ordered, append-only state history
-- brain_job_steps         its steps, attempts and SEALED checkpoints
-- brain_job_waits         the questions a durable job asks, and the one reply each accepts
-- brain_commands          START / RESUME / CANCEL, stored once per identity
-- brain_events            the allowlisted events Activity may read
-- ai_controls             the append-only log of stored AI controls
-- ai_control_current      the current version of each control, pointing at its log row
--
-- NOTHING WRITES THESE TABLES YET. B4 is schema plus repositories. No API, executor,
-- doorbell or provider call exists, and the AI runtime stays OFF. After this migration
-- the tables are empty and every existing code path behaves exactly as before.
--
-- ================== FOUR DECLARATIONS, NEVER ONE ==================
--
-- A job records, in separate columns: what the work needs ("capabilityRoute"); what it
-- produces and who holds it ("resultType", "resultOwnerAuthority", "resultSubjectType",
-- "resultSubjectId"); and how it runs ("executionClass", changed only by promotion).
-- There is NO provider, model, fallback or routing column on any Brain table: routing
-- chooses per call, and each call records its choice on ai_invocations.
--
-- ================== VOCABULARIES ARE TEXT ==================
--
-- Result types, capability routes, owners, subject types, step kinds and failure
-- reasons are TEXT validated in @emgloop/shared, not Postgres enums and not CHECKed:
-- adding one (DRAFT was added this way) is a reviewed contract change, never a
-- migration. The CHECK constraints at the end pin only what is STRUCTURAL -- the job
-- state machine, the execution classes, the command types, the wait statuses, the
-- control scopes -- and the shapes every row must have.
--
-- ================== TENANCY IS ENFORCED BY THE DATABASE ==================
--
-- Every child row reaches its job through a COMPOSITE foreign key on
-- ("organizationId", "jobId") -> brain_jobs("organizationId", "id"), so a transition,
-- step, wait, command or event can never point at another organization's job. A job
-- and a wait bind their principal through ("principalUserId", "organizationId") ->
-- organization_memberships("userId", "organizationId"): Brain work only ever runs on
-- the authority of somebody who holds a membership in THAT organization (the unique
-- index this uses already exists). A resumed job, and a ledger row's Brain job, are
-- tied to the same organization the same way.
--
-- NO ACTION on the principal and ledger keys: a person or a ledger row cannot be
-- removed out from under a job. Deleting an organization still cascades everything
-- in one statement, which NO ACTION (checked at the end of the statement) permits.
--
-- ================== CONTENT ==================
--
-- Checkpoint payloads are stored SEALED (encrypted before they reach this table,
-- with the key reference and seal version beside them). No table here has a column
-- for a prompt, a model response, a credential or context evidence. "input" holds the
-- submission's scalar task parameters, "question" the minimal structured question,
-- "reply" the validated reply: each is the job's own record, read under Loop's guards.
--
-- ================== THE CHANGE TO ai_invocations ==================
--
-- "brainJobId" and "brainStepKey" say which Brain job and step a provider call served;
-- "specializationPolicyVersion" says which specialization policy its routing conformed
-- to. All three are NULLABLE with no default, so adding them rewrites nothing, and
-- every existing row keeps its meaning. The CHECK below validates the (empty or
-- all-NULL) existing rows instantly. No usage, cost, provenance or privacy column
-- changes, and there is still no column for a prompt or a response.

-- AlterTable
ALTER TABLE "ai_invocations" ADD COLUMN     "brainJobId" TEXT,
ADD COLUMN     "brainStepKey" TEXT,
ADD COLUMN     "specializationPolicyVersion" TEXT;

-- CreateTable
CREATE TABLE "brain_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "principalUserId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskVersion" TEXT NOT NULL,
    "capabilityRoute" TEXT NOT NULL,
    "resultType" TEXT NOT NULL,
    "resultOwnerAuthority" TEXT NOT NULL,
    "resultSubjectType" TEXT NOT NULL,
    "resultSubjectId" TEXT NOT NULL,
    "executionClass" TEXT NOT NULL,
    "promotedAt" TIMESTAMP(3),
    "state" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "leaseHolder" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelActorKind" TEXT,
    "cancelActorUserId" TEXT,
    "cancelActorPolicy" TEXT,
    "cancelReason" TEXT,
    "endReason" TEXT,
    "currentWaitId" TEXT,
    "currentWaitExpiresAt" TIMESTAMP(3),
    "resultRefs" JSONB NOT NULL DEFAULT '[]',
    "input" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "submissionFingerprint" TEXT NOT NULL,
    "resumesJobId" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "activeElapsedMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brain_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brain_job_transitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "executionClass" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorPolicy" TEXT,
    "reason" TEXT,
    "waitId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brain_job_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brain_job_steps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "paidAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastFailureClass" TEXT,
    "checkpointSealed" BYTEA,
    "checkpointKeyRef" TEXT,
    "checkpointSealVersion" TEXT,
    "checkpointSizeBytes" INTEGER,
    "checkpointedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brain_job_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brain_job_waits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "principalUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "openJobKey" TEXT,
    "questionSchemaId" TEXT NOT NULL,
    "questionSchemaVersion" TEXT NOT NULL,
    "question" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "responderUserId" TEXT,
    "reply" JSONB,
    "replyFingerprint" TEXT,
    "answeredAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brain_job_waits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brain_commands" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "waitId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "issuerKind" TEXT NOT NULL,
    "issuerUserId" TEXT,
    "issuerPolicy" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "lastDispatchedAt" TIMESTAMP(3),
    "dispatchCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brain_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brain_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "resultType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorPolicy" TEXT,
    "resultRefs" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_controls" (
    "id" TEXT NOT NULL,
    "controlKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "organizationId" TEXT,
    "value" TEXT,
    "state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorReference" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_control_current" (
    "controlKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "organizationId" TEXT,
    "value" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_control_current_pkey" PRIMARY KEY ("controlKey")
);

-- CreateIndex
CREATE INDEX "brain_jobs_organizationId_principalUserId_state_idx" ON "brain_jobs"("organizationId", "principalUserId", "state");

-- CreateIndex
CREATE INDEX "brain_jobs_organizationId_resultSubjectType_resultSubjectId_idx" ON "brain_jobs"("organizationId", "resultSubjectType", "resultSubjectId", "state");

-- CreateIndex
CREATE INDEX "brain_jobs_state_leaseExpiresAt_idx" ON "brain_jobs"("state", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "brain_jobs_organizationId_id_key" ON "brain_jobs"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brain_jobs_organizationId_principalUserId_taskId_idempotenc_key" ON "brain_jobs"("organizationId", "principalUserId", "taskId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "brain_job_transitions_organizationId_jobId_sequence_idx" ON "brain_job_transitions"("organizationId", "jobId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "brain_job_transitions_jobId_sequence_key" ON "brain_job_transitions"("jobId", "sequence");

-- CreateIndex
CREATE INDEX "brain_job_steps_organizationId_jobId_idx" ON "brain_job_steps"("organizationId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "brain_job_steps_jobId_stepKey_key" ON "brain_job_steps"("jobId", "stepKey");

-- CreateIndex
CREATE INDEX "brain_job_waits_status_expiresAt_idx" ON "brain_job_waits"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "brain_job_waits_organizationId_jobId_idx" ON "brain_job_waits"("organizationId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "brain_job_waits_organizationId_id_key" ON "brain_job_waits"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brain_job_waits_organizationId_openJobKey_key" ON "brain_job_waits"("organizationId", "openJobKey");

-- CreateIndex
CREATE INDEX "brain_commands_dispatchedAt_issuedAt_idx" ON "brain_commands"("dispatchedAt", "issuedAt");

-- CreateIndex
CREATE INDEX "brain_commands_organizationId_jobId_idx" ON "brain_commands"("organizationId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "brain_commands_organizationId_dedupeKey_key" ON "brain_commands"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "brain_events_organizationId_occurredAt_id_idx" ON "brain_events"("organizationId", "occurredAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brain_events_jobId_sequence_key" ON "brain_events"("jobId", "sequence");

-- CreateIndex
CREATE INDEX "ai_controls_organizationId_recordedAt_idx" ON "ai_controls"("organizationId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_controls_controlKey_version_key" ON "ai_controls"("controlKey", "version");

-- CreateIndex
CREATE INDEX "ai_control_current_organizationId_idx" ON "ai_control_current"("organizationId");

-- CreateIndex
CREATE INDEX "ai_invocations_organizationId_brainJobId_brainStepKey_idx" ON "ai_invocations"("organizationId", "brainJobId", "brainStepKey");

-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_organizationId_brainJobId_fkey" FOREIGN KEY ("organizationId", "brainJobId") REFERENCES "brain_jobs"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_jobs" ADD CONSTRAINT "brain_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_jobs" ADD CONSTRAINT "brain_jobs_principalUserId_organizationId_fkey" FOREIGN KEY ("principalUserId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_jobs" ADD CONSTRAINT "brain_jobs_cancelActorUserId_fkey" FOREIGN KEY ("cancelActorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_jobs" ADD CONSTRAINT "brain_jobs_organizationId_resumesJobId_fkey" FOREIGN KEY ("organizationId", "resumesJobId") REFERENCES "brain_jobs"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_transitions" ADD CONSTRAINT "brain_job_transitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_transitions" ADD CONSTRAINT "brain_job_transitions_organizationId_jobId_fkey" FOREIGN KEY ("organizationId", "jobId") REFERENCES "brain_jobs"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_transitions" ADD CONSTRAINT "brain_job_transitions_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_steps" ADD CONSTRAINT "brain_job_steps_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_steps" ADD CONSTRAINT "brain_job_steps_organizationId_jobId_fkey" FOREIGN KEY ("organizationId", "jobId") REFERENCES "brain_jobs"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_waits" ADD CONSTRAINT "brain_job_waits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_waits" ADD CONSTRAINT "brain_job_waits_organizationId_jobId_fkey" FOREIGN KEY ("organizationId", "jobId") REFERENCES "brain_jobs"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_waits" ADD CONSTRAINT "brain_job_waits_principalUserId_organizationId_fkey" FOREIGN KEY ("principalUserId", "organizationId") REFERENCES "organization_memberships"("userId", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_job_waits" ADD CONSTRAINT "brain_job_waits_responderUserId_fkey" FOREIGN KEY ("responderUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_commands" ADD CONSTRAINT "brain_commands_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_commands" ADD CONSTRAINT "brain_commands_organizationId_jobId_fkey" FOREIGN KEY ("organizationId", "jobId") REFERENCES "brain_jobs"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_commands" ADD CONSTRAINT "brain_commands_organizationId_waitId_fkey" FOREIGN KEY ("organizationId", "waitId") REFERENCES "brain_job_waits"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_commands" ADD CONSTRAINT "brain_commands_issuerUserId_fkey" FOREIGN KEY ("issuerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_events" ADD CONSTRAINT "brain_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_events" ADD CONSTRAINT "brain_events_organizationId_jobId_fkey" FOREIGN KEY ("organizationId", "jobId") REFERENCES "brain_jobs"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_events" ADD CONSTRAINT "brain_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_controls" ADD CONSTRAINT "ai_controls_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_controls" ADD CONSTRAINT "ai_controls_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_control_current" ADD CONSTRAINT "ai_control_current_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_control_current" ADD CONSTRAINT "ai_control_current_controlKey_version_fkey" FOREIGN KEY ("controlKey", "version") REFERENCES "ai_controls"("controlKey", "version") ON DELETE CASCADE ON UPDATE CASCADE;


-- ================== HAND-WRITTEN SQL BELOW ==================
--
-- Prisma cannot express CHECK constraints; the database alone enforces these.
-- Instants written by the application (occurredAt, issuedAt, expiresAt...) are never
-- compared with database-defaulted ones, so clock skew cannot trip a constraint.

-- The job state machine's shape. A question is open exactly while the job waits, a
-- waiting job is durable, only a durable job was promoted, a lease is a holder and an
-- expiry together, a cancel request is complete or absent, exactly the terminal states
-- have ended, a success points at results and nothing else does, and an idle job holds
-- no lease once it has ended.
ALTER TABLE "brain_jobs" ADD CONSTRAINT "brain_jobs_shape"
  CHECK (
    "state" IN ('ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_FOR_USER', 'SUCCEEDED', 'FAILED', 'CANCELLED')
    AND "executionClass" IN ('INTERACTIVE', 'DURABLE')
    AND "generation" >= 1
    AND "version" >= 0
    AND "lastSequence" >= 0
    AND "activeElapsedMs" >= 0
    AND ("promotedAt" IS NULL OR "executionClass" = 'DURABLE')
    AND (("leaseHolder" IS NULL) = ("leaseExpiresAt" IS NULL))
    AND (("cancelRequestedAt" IS NULL) = ("cancelReason" IS NULL))
    AND (("cancelRequestedAt" IS NULL) = ("cancelActorKind" IS NULL))
    AND ("cancelActorKind" IS NULL OR "cancelActorKind" IN ('HUMAN', 'SYSTEM', 'POLICY'))
    AND (("cancelActorKind" IS NOT DISTINCT FROM 'POLICY') = ("cancelActorPolicy" IS NOT NULL))
    AND ("cancelActorKind" IS NOT DISTINCT FROM 'HUMAN' OR "cancelActorUserId" IS NULL)
    AND (("state" = 'WAITING_FOR_USER') = ("currentWaitId" IS NOT NULL))
    AND (("currentWaitId" IS NULL) = ("currentWaitExpiresAt" IS NULL))
    AND ("state" <> 'WAITING_FOR_USER' OR "executionClass" = 'DURABLE')
    AND (("state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = ("endedAt" IS NOT NULL))
    AND (("state" IN ('FAILED', 'CANCELLED')) = ("endReason" IS NOT NULL))
    AND ("endedAt" IS NULL OR "leaseHolder" IS NULL)
    AND jsonb_typeof("resultRefs") = 'array'
    AND (("state" = 'SUCCEEDED') = ("resultRefs" <> '[]'::jsonb))
    AND jsonb_typeof("input") = 'object'
    AND ("resumesJobId" IS NULL OR "resumesJobId" <> "id")
    AND length(btrim("idempotencyKey")) > 0
    AND "submissionFingerprint" ~ '^[0-9a-f]{64}$'
    AND length(btrim("taskId")) > 0
    AND length(btrim("taskVersion")) > 0
    AND length(btrim("capabilityRoute")) > 0
    AND length(btrim("resultType")) > 0
    AND length(btrim("resultOwnerAuthority")) > 0
    AND length(btrim("resultSubjectType")) > 0
    AND length(btrim("resultSubjectId")) > 0
  );

-- A history starts with its acceptance and names the states it moved between.
ALTER TABLE "brain_job_transitions" ADD CONSTRAINT "brain_job_transitions_shape"
  CHECK (
    "sequence" >= 1
    AND "kind" IN ('ACCEPTED', 'DISPATCHED', 'STARTED', 'PROMOTED', 'USER_INPUT_REQUESTED', 'USER_INPUT_RECEIVED',
                   'WAIT_EXPIRED', 'CANCEL_REQUESTED', 'CANCEL_SETTLED', 'RESULT_COMMITTED', 'FAILED')
    AND (("sequence" = 1) = ("kind" = 'ACCEPTED'))
    AND (("kind" = 'ACCEPTED') = ("fromState" IS NULL))
    AND "toState" IN ('ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_FOR_USER', 'SUCCEEDED', 'FAILED', 'CANCELLED')
    AND ("fromState" IS NULL OR "fromState" IN ('ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_FOR_USER'))
    AND "executionClass" IN ('INTERACTIVE', 'DURABLE')
    AND "actorKind" IN ('HUMAN', 'SYSTEM', 'POLICY')
    AND (("actorKind" = 'POLICY') = ("actorPolicy" IS NOT NULL))
    AND ("actorKind" = 'HUMAN' OR "actorUserId" IS NULL)
  );

-- A step's key is a plan key, its paid attempts never exceed its attempts, and exactly
-- a succeeded step carries a complete, non-empty sealed checkpoint.
ALTER TABLE "brain_job_steps" ADD CONSTRAINT "brain_job_steps_shape"
  CHECK (
    "state" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')
    AND "stepKey" ~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$'
    AND length(btrim("kind")) > 0
    AND length(btrim("inputFingerprint")) > 0
    AND "attempts" >= 0
    AND "paidAttempts" >= 0
    AND "paidAttempts" <= "attempts"
    AND (("state" = 'SUCCEEDED') = ("checkpointedAt" IS NOT NULL))
    AND (("checkpointedAt" IS NULL) = ("checkpointSealed" IS NULL))
    AND (("checkpointedAt" IS NULL) = ("checkpointKeyRef" IS NULL))
    AND (("checkpointedAt" IS NULL) = ("checkpointSealVersion" IS NULL))
    AND (("checkpointedAt" IS NULL) = ("checkpointSizeBytes" IS NULL))
    AND ("checkpointSealed" IS NULL OR (octet_length("checkpointSealed") > 0 AND octet_length("checkpointSealed") = "checkpointSizeBytes"))
  );

-- One open question per job (the open key is the job id while OPEN), exactly an
-- answered wait holds a reply, and only the principal can ever be its responder.
ALTER TABLE "brain_job_waits" ADD CONSTRAINT "brain_job_waits_shape"
  CHECK (
    "status" IN ('OPEN', 'ANSWERED', 'EXPIRED', 'CLOSED')
    AND (("status" = 'OPEN') = ("openJobKey" IS NOT NULL))
    AND ("openJobKey" IS NULL OR "openJobKey" = "jobId")
    AND (("status" = 'ANSWERED') = ("reply" IS NOT NULL))
    AND (("status" = 'ANSWERED') = ("replyFingerprint" IS NOT NULL))
    AND (("status" = 'ANSWERED') = ("answeredAt" IS NOT NULL))
    AND (("status" IN ('EXPIRED', 'CLOSED')) = ("closedAt" IS NOT NULL))
    AND ("status" = 'ANSWERED' OR "responderUserId" IS NULL)
    AND ("responderUserId" IS NULL OR "responderUserId" = "principalUserId")
    AND "expiresAt" > "requestedAt"
    AND length(btrim("questionSchemaId")) > 0
    AND length(btrim("questionSchemaVersion")) > 0
    AND jsonb_typeof("question") = 'object'
  );

-- A command is stored under exactly the identity brainCommandDedupeKey derives, only a
-- RESUME names a wait, and a dispatch count and its stamps agree.
ALTER TABLE "brain_commands" ADD CONSTRAINT "brain_commands_shape"
  CHECK (
    "type" IN ('START', 'RESUME', 'CANCEL')
    AND "generation" >= 1
    AND "dispatchCount" >= 0
    AND (("type" = 'RESUME') = ("waitId" IS NOT NULL))
    AND "dedupeKey" = CASE
      WHEN "type" = 'RESUME' THEN 'resume:' || "jobId" || ':' || "generation"::text || ':' || "waitId"
      ELSE lower("type") || ':' || "jobId" || ':' || "generation"::text
    END
    AND (("dispatchCount" = 0) = ("dispatchedAt" IS NULL))
    AND (("dispatchedAt" IS NULL) = ("lastDispatchedAt" IS NULL))
    AND "issuerKind" IN ('HUMAN', 'SYSTEM', 'POLICY')
    AND (("issuerKind" = 'POLICY') = ("issuerPolicy" IS NOT NULL))
    AND ("issuerKind" = 'HUMAN' OR "issuerUserId" IS NULL)
  );

-- An event's id is derived from the transition it reports, it is one of the approved
-- events, and only a success points at results.
ALTER TABLE "brain_events" ADD CONSTRAINT "brain_events_shape"
  CHECK (
    "sequence" >= 1
    AND "id" = "jobId" || '#' || "sequence"::text
    AND "name" IN ('brain.job.accepted', 'brain.job.promoted', 'brain.job.waiting_for_user',
                   'brain.job.succeeded', 'brain.job.failed', 'brain.job.cancelled')
    AND "actorKind" IN ('HUMAN', 'SYSTEM', 'POLICY')
    AND (("actorKind" = 'POLICY') = ("actorPolicy" IS NOT NULL))
    AND ("actorKind" = 'HUMAN' OR "actorUserId" IS NULL)
    AND jsonb_typeof("resultRefs") = 'array'
    AND ("name" = 'brain.job.succeeded' OR "resultRefs" = '[]'::jsonb)
    AND length(btrim("taskId")) > 0
    AND length(btrim("resultType")) > 0
  );

-- A control's key is derived from its target, its target is coherent for its scope,
-- it gives a reason, and it names who recorded it: a person, or an operations run.
ALTER TABLE "ai_controls" ADD CONSTRAINT "ai_controls_shape"
  CHECK (
    "scope" IN ('GLOBAL', 'PROVIDER', 'MODEL', 'TASK', 'ORGANIZATION')
    AND "state" IN ('ACTIVE', 'KILLED')
    AND "version" >= 1
    AND "controlKey" = "scope" || '|' || coalesce("organizationId", '-') || '|' || coalesce("value", '-')
    AND ("scope" NOT IN ('GLOBAL', 'PROVIDER', 'MODEL') OR "organizationId" IS NULL)
    AND ("scope" <> 'ORGANIZATION' OR ("organizationId" IS NOT NULL AND "value" = "organizationId"))
    AND (("scope" = 'GLOBAL') = ("value" IS NULL))
    AND length(btrim("reason")) > 0
    AND "actorKind" IN ('HUMAN', 'OPERATIONS')
    AND ("actorKind" = 'HUMAN' OR "actorUserId" IS NULL)
    AND (("actorKind" = 'OPERATIONS') = ("actorReference" IS NOT NULL))
    AND ("actorReference" IS NULL OR length(btrim("actorReference")) > 0)
  );

-- The current view names the same target its key derives from, so it can only ever
-- point at that target's own history (the foreign key above does the rest).
ALTER TABLE "ai_control_current" ADD CONSTRAINT "ai_control_current_shape"
  CHECK (
    "version" >= 1
    AND "controlKey" = "scope" || '|' || coalesce("organizationId", '-') || '|' || coalesce("value", '-')
  );

-- A Brain call names its job and step together, and its ledger key is the one
-- brainCallKey derives from them. Existing rows carry NULLs and pass.
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_brain_call"
  CHECK (
    (("brainJobId" IS NULL) = ("brainStepKey" IS NULL))
    AND ("brainJobId" IS NULL OR starts_with("invocationId", "brainJobId" || ':' || "brainStepKey" || ':'))
    AND ("specializationPolicyVersion" IS NULL OR length(btrim("specializationPolicyVersion")) > 0)
  );
