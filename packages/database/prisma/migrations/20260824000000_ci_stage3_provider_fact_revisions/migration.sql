-- Commercial Intelligence Stage 3: why a canonical provider fact changed.
--
-- ADDITIVE ONLY. One new table, two indexes, one foreign key. Zero DROP. Zero
-- rename. Zero column-type change. Zero backfill. Nothing seeded. No existing
-- table or column is touched.
--
-- ASCII ONLY. A leading em-dash in the sprint_11 migration blocked replay of the
-- entire ledger once (see PR #152); this header is deliberately plain ASCII.
--
-- WHY A TABLE AND NOT A LOG
--
-- CallGrid records mutate after the call ends -- "BillableType is POSTBACK.
-- Revenue and billable will be set when the postback is received" -- so a later
-- observation can legitimately change a canonical money value. The moment a
-- stored number can change because of something that arrived later, a log line
-- is not enough: a reader looking at a revenue of 1700 has to be able to find
-- out that it was unknown until the postback landed, and which observation
-- supplied it.
--
-- BOUNDED BY CHANGES, NOT BY OBSERVATIONS. This is the distinction that makes
-- the table affordable. A poller re-reading a 48-hour overlap every fifteen
-- minutes produces roughly 192 OBSERVATIONS per call and almost always zero
-- revisions: a row is written only when a fact actually changed, or when two
-- settled values disagreed. A postback settles once. The observation set on
-- integration_events already records that the looking happened.
--
-- CONFLICTS ARE ROWS TOO, AND THEY CARRY NO NEW VALUE. When two settled amounts
-- disagree -- 1700 then 1500 -- nothing is written to the canonical call,
-- because a provider correction and a defect are indistinguishable from here and
-- silently choosing one would rewrite money. The disagreement is recorded so a
-- person can settle it, and `appliedAt` stays NULL to say the canonical value
-- did not move.
--
-- NOT AN EVENT STREAM. It has no consumer, no ordering guarantee beyond its own
-- timestamps and no publish semantics. It is evidence attached to a fact.

CREATE TABLE "provider_fact_revisions" (
  "id"                 TEXT NOT NULL,
  "organizationId"     TEXT NOT NULL,
  "provider"           TEXT NOT NULL,
  -- The provider's own call id. Deliberately NOT a foreign key to
  -- marketplace_calls: a revision explains an observation, and it must survive a
  -- projection being rebuilt.
  "externalId"         TEXT NOT NULL,
  -- Which canonical fact. From the closed CALLGRID_FACT_KINDS vocabulary, stored
  -- as text so it can widen without DDL; readers fail closed.
  "fact"               TEXT NOT NULL,
  -- The decision the pure rule reached: UPDATE or CONFLICT. KEEP_EXISTING and
  -- REMAIN_UNKNOWN are not recorded -- nothing happened and a row per non-event
  -- is how a table becomes a log.
  "decision"           TEXT NOT NULL,
  -- Rendered values, not typed columns: one table holds money and booleans, and
  -- a reader needs to see what was there rather than re-derive it. NULL means
  -- the fact was unknown at that side of the change.
  "fromValue"          TEXT,
  "toValue"            TEXT,
  -- Which observation path carried the new evidence, and Loop's clock when it
  -- did. Both from the same observation that produced the decision.
  "observationSource"  TEXT NOT NULL,
  "observedAt"         TIMESTAMP(3) NOT NULL,
  -- The delivery this decision was made from, so the raw payload behind it stays
  -- reachable. ON DELETE SET NULL: losing the event must not lose the fact that
  -- money changed.
  "integrationEventId" TEXT,
  -- Set only when the canonical value actually moved. NULL on a CONFLICT.
  "appliedAt"          TIMESTAMP(3),
  "reason"             TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "provider_fact_revisions_pkey" PRIMARY KEY ("id")
);

-- The read a person makes: everything that ever changed about one call.
CREATE INDEX "provider_fact_revisions_org_provider_external_idx"
  ON "provider_fact_revisions"("organizationId", "provider", "externalId");

-- The read an operator makes: unresolved disagreements, newest first.
CREATE INDEX "provider_fact_revisions_org_decision_observedAt_idx"
  ON "provider_fact_revisions"("organizationId", "decision", "observedAt");

ALTER TABLE "provider_fact_revisions"
  ADD CONSTRAINT "provider_fact_revisions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "provider_fact_revisions"
  ADD CONSTRAINT "provider_fact_revisions_integrationEventId_fkey"
  FOREIGN KEY ("integrationEventId") REFERENCES "integration_events"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
