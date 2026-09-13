-- CRM Phase Zero P0.2b: organization membership, separate from the login.
--
-- ADDITIVE, PLUS ONE DETERMINISTIC BACKFILL. One enum, one table, two indexes,
-- three foreign keys, one INSERT ... SELECT. Zero DROP. Zero rename. Zero
-- column-type change. No existing row is updated or deleted: `users` is only
-- READ, and every membership it implies is written to the new table.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this file is deliberately plain ASCII.
--
-- ================== WHAT THIS ADDS, AND WHY ==================
--
-- `users.organizationId` is scalar, so the User row has been the login, the
-- authorization principal AND the membership at once. One person in two
-- organizations had to be two unrelated logins. This table holds membership on
-- its own -- user x organization x system role x status x inviter x effective
-- dates -- so that can change without re-keying a single historical actor.
-- `users` keeps every column, including `organizationId`.
--
-- NOTHING READS THIS TABLE FOR AUTHORITY YET. Session and permission resolution
-- still read `users`. Application code writes a membership in the same
-- transaction as every User lifecycle write; P0.2c moves authority here only
-- after this backfill is verified complete in production.
--
-- ================== THE BACKFILL, EXACTLY ==================
--
-- One membership per existing User row, derived ONLY from what that row already
-- means -- the same rule `membershipFromUser` applies in application code:
--
--   organizationId  users.organizationId, verbatim.
--   systemRole      metadata.systemRole when it is a JSON string naming a real
--                   SystemRole; EMPLOYEE when it is absent or not a string (what
--                   `userSystemRole` has always answered). A string that names no
--                   role gets NO membership: today's resolver cannot grant
--                   anything from it, and choosing one would be a guess.
--   status          REMOVED when users.status is DISABLED and metadata.removedAt
--                   is truthy (JavaScript truthiness, which `listUsers` applies);
--                   otherwise users.status verbatim.
--   invitedByUserId NULL. Nothing on the User row records an inviter.
--   effectiveFrom   users.createdAt.
--   effectiveTo     for REMOVED only: metadata.removedAt when it is an ISO-8601
--                   UTC instant that parses, else NULL. Never inferred.
--   id              'mbr_' || users.id -- deterministic, so the row traces to its
--                   source and a replay cannot mint a second one.
--
-- Same-email rows in different organizations are different Users and receive
-- different memberships. Nothing is merged. No Party is created.

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED', 'REMOVED');

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "systemRole" "SystemRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL,
    "invitedByUserId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_memberships_organizationId_status_idx" ON "organization_memberships"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_userId_organizationId_key" ON "organization_memberships"("userId", "organizationId");

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one membership per User row, derived from that row alone.
--
-- A malformed removal timestamp must never abort this migration, so the
-- conversion goes through a session-temporary function that answers NULL for
-- anything that is not a parseable instant. pg_temp objects vanish with the
-- connection; nothing is left in the schema.
CREATE FUNCTION pg_temp.p02b_instant(value TEXT) RETURNS TIMESTAMP(3)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' THEN
    RETURN NULL;
  END IF;
  RETURN (value::timestamptz AT TIME ZONE 'UTC')::timestamp(3);
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

WITH derived AS (
  SELECT
    u."id"             AS "userId",
    u."organizationId" AS "organizationId",
    u."createdAt"      AS "createdAt",
    u."status"::text   AS "userStatus",
    CASE
      WHEN jsonb_typeof(u."metadata" -> 'systemRole') = 'string' THEN u."metadata" ->> 'systemRole'
      ELSE 'EMPLOYEE'
    END AS "role",
    CASE jsonb_typeof(u."metadata" -> 'removedAt')
      WHEN 'string'  THEN (u."metadata" ->> 'removedAt') <> ''
      WHEN 'boolean' THEN (u."metadata" ->> 'removedAt')::boolean
      WHEN 'number'  THEN (u."metadata" ->> 'removedAt')::numeric <> 0
      WHEN 'object'  THEN true
      WHEN 'array'   THEN true
      ELSE false
    END AS "removedMarker",
    CASE
      WHEN jsonb_typeof(u."metadata" -> 'removedAt') = 'string' THEN u."metadata" ->> 'removedAt'
      ELSE NULL
    END AS "removedAtText"
  FROM "users" u
)
INSERT INTO "organization_memberships"
  ("id", "organizationId", "userId", "systemRole", "status",
   "invitedByUserId", "effectiveFrom", "effectiveTo", "createdAt", "updatedAt")
SELECT
  'mbr_' || d."userId",
  d."organizationId",
  d."userId",
  d."role"::"SystemRole",
  (CASE
     WHEN d."userStatus" = 'DISABLED' AND d."removedMarker" THEN 'REMOVED'
     ELSE d."userStatus"
   END)::"MembershipStatus",
  NULL,
  d."createdAt",
  CASE
    WHEN d."userStatus" = 'DISABLED' AND d."removedMarker" THEN pg_temp.p02b_instant(d."removedAtText")
    ELSE NULL
  END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM derived d
WHERE d."role" IN ('OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'AI_EMPLOYEE', 'READ_ONLY')
  AND d."userStatus" IN ('INVITED', 'ACTIVE', 'DISABLED')
ON CONFLICT ("userId", "organizationId") DO NOTHING;
