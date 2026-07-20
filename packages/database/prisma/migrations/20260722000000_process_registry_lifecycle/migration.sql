-- Sprint 27F — Process Registry (PR D-prep)
-- ---------------------------------------------------------------------------
-- Additive lifecycle columns for process_definitions. The Registry now owns a
-- five-state lifecycle (draft → published → active → superseded → retired); this
-- records WHEN a definition entered the three new states. No existing column is
-- touched, no data is rewritten, and no other table changes. Fully reversible.
--
-- `status` remains a String; its permitted vocabulary widens from
-- (draft | published) to (draft | published | active | superseded | retired).
-- Existing rows keep their current status untouched.
-- ---------------------------------------------------------------------------

ALTER TABLE "process_definitions" ADD COLUMN "activatedAt" TIMESTAMP(3);
ALTER TABLE "process_definitions" ADD COLUMN "supersededAt" TIMESTAMP(3);
ALTER TABLE "process_definitions" ADD COLUMN "retiredAt" TIMESTAMP(3);
