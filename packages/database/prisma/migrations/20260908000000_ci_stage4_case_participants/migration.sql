-- Commercial Intelligence Stage 4: who is involved in an investigation, and what
-- each of them is being asked for.
--
-- ADDITIVE ONLY. One new table, one unique index, two secondary indexes, five
-- foreign keys. Zero DROP. Zero rename. Zero column-type change. Zero backfill.
-- Nothing seeded. No existing table or column is touched -- the relation fields
-- added to Organization, User and OperationalPriority in schema.prisma are Prisma
-- back-relations, which are read-side only and produce no DDL.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- WHY A TABLE AND NOT TWO MORE COLUMNS
--
-- operational_priorities already carries ownerUserId (accountability -- who
-- answers for this reaching an outcome) and assigneeUserId (execution -- who is
-- actively working it), and keeping those apart was correct. But an
-- investigation routinely needs THREE people for three different reasons: one to
-- decide, one to change something technical, one to handle the counterparty.
-- Two columns cannot hold that. Rotating assigneeUserId between them would
-- destroy the only answer to "who is working this", and naming one of them owner
-- would silently demote the other two to nobody.
--
-- WHAT THIS TABLE IS NOT, AND WHY THE ABSENCES ARE THE POINT
--
-- There is no due date. No dependency. No SLA. No blocked state. No completion.
-- No status column of any kind. Every one of those describes an EXECUTION
-- OBLIGATION, and this platform already has a layer that owns those: Work OS,
-- through work_instances / work_stages / work_assignments. A case that carried
-- its own task status beside a Work status would be a second answer to "is it
-- done", and the copy is always the one that goes stale.
--
-- Where an investigation does become work, the case REFERENCES the work object
-- through the destination columns operational_observations already carries on a
-- CONVERTED_TO_WORK outcome (destinationSystem / destinationType /
-- destinationId). Nothing about the work's mutable state is copied here.
--
-- NO STATUS COLUMN EITHER. Presence and release, following work_assignments' own
-- assignedAt / unassignedAt convention rather than inventing an enum beside it.
-- A participant is active exactly when releasedAt IS NULL, which cannot disagree
-- with itself the way a status maintained beside a timestamp can.
--
-- CONTRIBUTION IS A TEXT COLUMN, NOT AN ENUM
--
-- The same stance operational_priorities.severity already takes: a new kind of
-- contribution should be a value a producer supplies, not a migration that has to
-- reach production by hand before the code that emits it can ship. The closed
-- list lives in CASE_CONTRIBUTIONS in @emgloop/shared and is validated at the
-- service boundary, where the rejection is visible.
--
-- REQUEST IS NOT NULL, DELIBERATELY
--
-- A participant with no stated reason is a name on a list, and the next person to
-- open the case has to guess what was wanted from them. There is no default: a
-- caller that cannot say why somebody is involved has not finished thinking about
-- it, and a fabricated default would hide that.
--
-- ONE ROW PER PERSON PER CONTRIBUTION PER CASE
--
-- The unique makes re-adding somebody idempotent rather than accumulating
-- duplicates, and lets one person legitimately hold two different roles on one
-- investigation -- Matt investigating AND deciding is a real shape. The HISTORY
-- of being added, changed and released lives on the case's append-only
-- observation log, which is where every other lifecycle fact in the Decision
-- Center already lives; this table holds current involvement, not its story.
--
-- FOREIGN KEYS, INCLUDING organizationId
--
-- Ten existing tables carry organizationId with no FK, and deleting an
-- organization orphans them. That is known debt and this migration does not add
-- to it. Cascade from organization and from the investigation, because a
-- participant row has no meaning without either. SetNull on addedByUserId and
-- releasedByUserId, following audit_logs and performance_objectives: who asked is
-- attribution and should survive them leaving. Cascade on userId, because the row
-- IS that person's involvement.
--
-- NOT APPLIED IN PRODUCTION BY THIS BRANCH. Migrations reach production only via
-- the manual Deploy Prisma Migrations workflow, run by a human. This branch is
-- code-complete and not live until somebody dispatches it.

-- CreateTable
CREATE TABLE "case_participants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "priorityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contribution" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "addedByUserId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "case_participants_priority_user_contribution_key" ON "case_participants"("priorityId", "userId", "contribution");

-- CreateIndex
CREATE INDEX "case_participants_org_priority_idx" ON "case_participants"("organizationId", "priorityId");

-- CreateIndex
CREATE INDEX "case_participants_org_user_released_idx" ON "case_participants"("organizationId", "userId", "releasedAt");

-- AddForeignKey
ALTER TABLE "case_participants" ADD CONSTRAINT "case_participants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_participants" ADD CONSTRAINT "case_participants_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "operational_priorities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_participants" ADD CONSTRAINT "case_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_participants" ADD CONSTRAINT "case_participants_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_participants" ADD CONSTRAINT "case_participants_releasedByUserId_fkey" FOREIGN KEY ("releasedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
