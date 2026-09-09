-- Work OS -- the execution clock, waiting, dependencies and the history all
-- three are derived from.
--
-- WHAT WAS MISSING. Work OS owned execution and could not express any of it. A
-- schema-wide search before this migration returned zero due-date columns, zero
-- dependency relations, zero SLA fields and zero blocked or waiting states,
-- anywhere. `work_stages.status` held pending / ready / in_progress / completed
-- / skipped, so a person waiting a week on a buyer and a person sitting on
-- something for a week were the same row.
--
-- WHY IT IS BEING ADDED HERE AND NOT IN COMMERCIAL INTELLIGENCE. A Case can ask
-- somebody to do something; it cannot own whether they did it, when it was due,
-- or what is stopping them. Putting a clock in CI would have created a second
-- task truth -- two systems both believing they know whether a thing is late,
-- disagreeing the moment one of them is not written to. The previous Stage 4
-- package stopped rather than build that. This is the same capability, built on
-- the side of the boundary that owns it.
--
-- ================== WHAT THIS ADDS ==================
--
-- 1. work_stages.actionable_at, work_stages.due_at
--    Both NULLABLE, and neither is backfilled or defaulted.
--
--    A DEFAULT WOULD FABRICATE BUSINESS MEANING. Defaulting due_at to anything
--    would invent an obligation nobody agreed to and would make every existing
--    row retroactively late. Defaulting actionable_at to created_at would claim
--    Loop measured something it never measured.
--
--    NULL MEANS UNKNOWN, AND UNKNOWN IS REPORTED. Every work item created before
--    this migration has no execution history, and the assessor returns
--    SLA_STATES = 'UNKNOWN' for it rather than 'WITHIN_POLICY'. A system that
--    reported unmeasured work as compliant would be issuing a clean bill of
--    health it never earned.
--
-- 2. work_stage_events -- append-only history, one row per thing that happened.
--
--    WHY A LOG AND NOT COUNTERS. Stage 4 has to answer how long an obligation
--    has been actionable, how long it waited internally versus externally, and
--    how many times its expected time was moved. Those are durations, and a
--    duration cannot be recovered from a current-state column. Counter columns
--    drift the first time an event is written without them. The Decision Center
--    reached the same conclusion for a Case and this follows it.
--
--    NO updated_at COLUMN. Deliberate: these rows are never updated. A
--    projection is rebuilt from them; they are not corrected.
--
--    NOT A DELIVERY RECORD. "A reminder fired" is a fact about a notification.
--    Reminder and escalation eligibility are DERIVED from these rows on every
--    read, so they cannot go stale and cannot be faked by writing a flag.
--
-- 3. work_dependencies -- one obligation waiting on another, or on a named
--    external condition.
--
--    DELIBERATELY NOT STAGE-TO-STAGE WITHIN ONE WORK ITEM. work_stages.position
--    already sequences the steps of a work item, and completeWorkStep already
--    readies the next one. A dependency row restating that would be a second
--    representation of a fact the position column already owns, and the two
--    would disagree the first time somebody skipped a step.
--
--    A RESOLVED DEPENDENCY KEEPS ITS ROW. Deleting it would erase the reason a
--    piece of work was stalled for a week, which is precisely the history
--    somebody wants afterwards.
--
-- ================== WHAT IT DOES NOT DO ==================
--
--   * No column is dropped, renamed or retyped. work_stages.status stays a
--     text column with the same default; three values are added to its
--     vocabulary in code, and no existing row uses them.
--   * No row anywhere is updated. Not one.
--   * No backfill. Historical work is left honestly unmeasured.
--   * No enum is altered. Both new tables use text columns whose vocabularies
--     live in `@emgloop/shared`, matching how work_stages.status already works
--     rather than introducing a different convention beside it.
--
-- ================== TENANCY ==================
--
-- Both new tables carry organization_id AND a real foreign key to organizations
-- with ON DELETE CASCADE. The original Work OS tables carry organization_id as
-- a bare string with no FK -- which is why CLAUDE.md records that deleting an
-- organization orphans them -- and new tables do not repeat that.
--
-- work_stages itself has no organization_id and is scoped through
-- work_instances; the repository resolves the instance within the organization
-- first, so a stage in another tenant is not reachable to be written against.
--
-- ================== INDEXES, AND WHY EACH ONE ==================
--
--   * work_stages(status, due_at)              -- the queue read: everything
--                                                 actionable, soonest first.
--   * work_stage_events(work_stage_id, sequence) UNIQUE
--                                              -- the append boundary. A
--                                                 concurrent double-append
--                                                 fails loudly instead of
--                                                 silently interleaving.
--   * work_stage_events(organization_id, work_stage_id, sequence)
--                                              -- the replay, tenant-scoped.
--   * work_stage_events(organization_id, event_type, occurred_at)
--                                              -- "what changed today".
--   * work_stage_events(dependency_id)         -- a dependency's own history.
--   * work_dependencies(work_stage_id, depends_on_work_instance_id) UNIQUE
--                                              -- one stage cannot declare the
--                                                 same work dependency twice.
--                                                 NULLs are distinct in
--                                                 Postgres, so several external
--                                                 conditions on one stage stay
--                                                 legal, which they should be.
--   * work_dependencies(organization_id, work_stage_id, resolved_at)
--                                              -- "what is blocking this".
--   * work_dependencies(organization_id, depends_on_work_instance_id, resolved_at)
--                                              -- the reactivation read: when a
--                                                 work item completes, what was
--                                                 waiting on it.
--
-- ================== DEPLOYMENT ==================
--
-- NOT APPLIED IN PRODUCTION. Migrations reach production only through the manual
-- `Deploy Prisma Migrations` workflow_dispatch. Nothing in this migration
-- requires configuration afterwards: the new columns are nullable, the new
-- tables are empty, and every existing read path behaves exactly as it did.

-- 1. Execution truth on the obligation itself.
ALTER TABLE "work_stages" ADD COLUMN IF NOT EXISTS "actionableAt" TIMESTAMP(3);
ALTER TABLE "work_stages" ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "work_stages_status_dueAt_idx" ON "work_stages"("status", "dueAt");

-- 2. The append-only history everything is derived from.
CREATE TABLE IF NOT EXISTS "work_stage_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workInstanceId" TEXT NOT NULL,
    "workStageId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "waitReason" TEXT,
    "waitSubject" TEXT,
    "expectedResolutionAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "dependencyId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'HUMAN',
    "actorUserId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'work-os',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_stage_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "work_stage_events_workStageId_sequence_key"
    ON "work_stage_events"("workStageId", "sequence");
CREATE INDEX IF NOT EXISTS "work_stage_events_organizationId_workStageId_sequence_idx"
    ON "work_stage_events"("organizationId", "workStageId", "sequence");
CREATE INDEX IF NOT EXISTS "work_stage_events_organizationId_eventType_occurredAt_idx"
    ON "work_stage_events"("organizationId", "eventType", "occurredAt");
CREATE INDEX IF NOT EXISTS "work_stage_events_dependencyId_idx"
    ON "work_stage_events"("dependencyId");

-- 3. One obligation waiting on another, or on a named external condition.
CREATE TABLE IF NOT EXISTS "work_dependencies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workStageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dependsOnWorkInstanceId" TEXT,
    "conditionSubject" TEXT,
    "description" TEXT NOT NULL,
    "expectedResolutionAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedByUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_dependencies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "work_dependencies_stage_depends_on_key"
    ON "work_dependencies"("workStageId", "dependsOnWorkInstanceId");
CREATE INDEX IF NOT EXISTS "work_dependencies_organizationId_workStageId_resolvedAt_idx"
    ON "work_dependencies"("organizationId", "workStageId", "resolvedAt");
CREATE INDEX IF NOT EXISTS "work_dependencies_organizationId_dependsOn_resolvedAt_idx"
    ON "work_dependencies"("organizationId", "dependsOnWorkInstanceId", "resolvedAt");

-- 4. Foreign keys.
--
-- CASCADE ON THE OWNING ROW, in both cases. A stage's history and its blocks
-- describe that stage; when the stage is deleted they describe nothing, and
-- keeping them would leave rows pointing at an id that no longer resolves.
-- Deleting an organization takes both with it, which is the orphaning the
-- original Work OS tables cannot prevent.
--
-- NO FOREIGN KEY ON dependsOnWorkInstanceId, DELIBERATELY. It is checked within
-- the organization at write time and resolved through the repository on every
-- read. A cascade here would silently delete the reason a piece of work was
-- blocked when the blocking work item was removed, and a restrict would make
-- deleting a work item fail for a reason nobody could see. The dependency
-- survives, and reads as pointing at work that is no longer there -- which is
-- the truth.
ALTER TABLE "work_stage_events"
    ADD CONSTRAINT "work_stage_events_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_stage_events"
    ADD CONSTRAINT "work_stage_events_workStageId_fkey"
    FOREIGN KEY ("workStageId") REFERENCES "work_stages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_dependencies"
    ADD CONSTRAINT "work_dependencies_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_dependencies"
    ADD CONSTRAINT "work_dependencies_workStageId_fkey"
    FOREIGN KEY ("workStageId") REFERENCES "work_stages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
