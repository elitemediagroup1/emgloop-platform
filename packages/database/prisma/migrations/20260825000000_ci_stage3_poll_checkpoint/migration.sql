-- Commercial Intelligence Stage 3: through what provider time has routine
-- polling proven coverage?
--
-- ADDITIVE ONLY. One new table, one unique index, one foreign key. Zero DROP.
-- Zero rename. Zero column-type change. Zero backfill. Nothing seeded. No
-- existing table or column is touched.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- WHY A TABLE AND NOT A JSON FIELD
--
-- provider_connections.config already holds a lastApiSync diagnostic blob, and
-- provider_connections.lastSyncedAt already exists -- and neither can own this.
-- lastSyncedAt is written by the WEBHOOK route as well as the sync route, so it
-- means "something happened on this connection", which is precisely the thing a
-- coverage claim must not depend on. And a checkpoint is operational state that
-- has to be advanced under concurrency: a monotonic guard is expressible as
-- "UPDATE ... WHERE completedThrough < :candidate" against a column, and is not
-- expressible against a value buried in a JSON document without reading it,
-- deciding, and writing it back -- which is the read-then-write race the guard
-- exists to remove.
--
-- WHAT THE VALUE MEANS
--
-- The EXCLUSIVE upper bound of the most recent half-open interval whose provider
-- read completed AND whose records were fully applied. It is deliberately NOT
-- the newest observed call occurrence: a provider interval can legitimately hold
-- zero calls, and on a quiet night a max() has nothing to return while coverage
-- is in fact complete. It is deliberately NOT the time the poller last ran: a
-- failed run still ran, and a run that lags its upper bound behind the clock
-- covered less than the moment it executed.
--
-- MONOTONIC, BY THE UPDATE AND NOT BY A LOCK. Advancement is a conditional
-- update guarded on the stored value being older than the candidate, following
-- the same conditional-update pattern headlines already use for resighting. Two
-- concurrent pollers may overlap harmlessly -- ingestion is idempotent on
-- (provider, externalId) -- and the slower one simply matches zero rows.
--
-- NO ROW MEANS NO COVERAGE HAS BEEN PROVEN. This migration creates the table
-- EMPTY and inserts nothing. There is no default, no seeded instant and no
-- fabricated starting point: a checkpoint that claimed coverage on the day it
-- was created would be a lie written by a migration. The first row appears the
-- first time a poll proves an interval.
--
-- SAFE BEFORE ANY SCHEDULER EXISTS. Nothing reads this table on a request path,
-- nothing writes it on a timer, and no code in this release advances it except a
-- routine poll a person starts. Deploying it changes no behaviour at all.

CREATE TABLE "provider_poll_checkpoints" (
  "id"                TEXT NOT NULL,
  "organizationId"    TEXT NOT NULL,
  "provider"          TEXT NOT NULL,
  "stream"            TEXT NOT NULL,
  "completedThrough"  TIMESTAMP(3) NOT NULL,
  "lastIntervalSince" TIMESTAMP(3) NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "provider_poll_checkpoints_pkey" PRIMARY KEY ("id")
);

-- Tenant-first identity, matching provider_observation_days. One organization's
-- proven coverage can never satisfy another organization's poll. This is also
-- what makes the create path safe under concurrency: two pollers racing to write
-- the first row collide here rather than producing two checkpoints.
CREATE UNIQUE INDEX "poll_checkpoint_identity"
  ON "provider_poll_checkpoints" ("organizationId", "provider", "stream");

ALTER TABLE "provider_poll_checkpoints"
  ADD CONSTRAINT "provider_poll_checkpoints_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
