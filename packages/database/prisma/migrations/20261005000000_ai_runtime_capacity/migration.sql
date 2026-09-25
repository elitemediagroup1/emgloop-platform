-- AI runtime capacity: lanes, recorded cost, and the recorded operating budget. PR 1, 2026-09-26.
--
-- ADDITIVE ONLY. Two nullable columns on ai_invocations ("lane", "costMicros"), one nullable column on
-- ai_controls ("settings"), each with a CHECK, and the ai_controls_shape CHECK re-stated with one more
-- permitted scope (BUDGET). Every row either constraint accepted before, it accepts now: existing rows
-- carry NULL in every new column and one of the six earlier scopes. No row is read, written or moved.
-- Safe to apply to a live database.
--
-- WHY.
--   "lane"        the capacity lane a call ran in (FORWARD, SYNTHESIS, INTERACTIVE, BACKGROUND), so a
--                 day's spend can be split and background work held to its own share. NULL on rows
--                 written before this migration.
--   "costMicros"  the call's cost at the route's price list, from the usage the provider reported,
--                 written when the call reconciles. The raw usage and "unitCostBasis" remain the cost of
--                 record; this is the figure the daily cost caps sum. NULL while in flight, and NULL when
--                 the provider reported no usage (such a call counts zero, as its tokens do).
--   "settings"    BUDGET only: the operating budget's figures (capacity.ts), validated before they are
--                 recorded and again when they are read.
--
-- DEPLOYMENT ORDER. The code reads these columns only after probing that they exist, so it may be
-- deployed before or after this migration. Apply it before recording an operating budget
-- (record-ai-budget workflow): that workflow writes "settings".
--
-- The constraint is dropped and re-added rather than altered because Postgres has no ALTER
-- CONSTRAINT for a CHECK; both statements run in the one migration transaction.
--
-- ASCII only: an em-dash in a migration once blocked replay of an entire ledger.

-- AlterTable
ALTER TABLE "ai_invocations" ADD COLUMN "lane" TEXT;
ALTER TABLE "ai_invocations" ADD COLUMN "costMicros" INTEGER;

ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_capacity"
  CHECK (
    ("lane" IS NULL OR "lane" IN ('FORWARD', 'SYNTHESIS', 'INTERACTIVE', 'BACKGROUND'))
    AND ("costMicros" IS NULL OR "costMicros" >= 0)
  );

-- AlterTable
ALTER TABLE "ai_controls" ADD COLUMN "settings" JSONB;

ALTER TABLE "ai_controls" DROP CONSTRAINT "ai_controls_shape";

ALTER TABLE "ai_controls" ADD CONSTRAINT "ai_controls_shape"
  CHECK (
    "scope" IN ('GLOBAL', 'PROVIDER', 'MODEL', 'TASK', 'ORGANIZATION', 'PROVIDER_POLICY', 'BUDGET')
    AND "state" IN ('ACTIVE', 'KILLED')
    AND "version" >= 1
    AND "controlKey" = "scope" || '|' || coalesce("organizationId", '-') || '|' || coalesce("value", '-')
    AND ("scope" NOT IN ('GLOBAL', 'PROVIDER', 'MODEL', 'PROVIDER_POLICY', 'BUDGET') OR "organizationId" IS NULL)
    AND ("scope" <> 'ORGANIZATION' OR ("organizationId" IS NOT NULL AND "value" = "organizationId"))
    AND (("scope" = 'GLOBAL') = ("value" IS NULL))
    AND length(btrim("reason")) > 0
    AND "actorKind" IN ('HUMAN', 'OPERATIONS')
    AND ("actorKind" = 'HUMAN' OR "actorUserId" IS NULL)
    AND (("actorKind" = 'OPERATIONS') = ("actorReference" IS NOT NULL))
    AND ("actorReference" IS NULL OR length(btrim("actorReference")) > 0)
    -- G2: a ceiling belongs to a provider policy and nothing else; an ACTIVE policy names one.
    AND ("ceiling" IS NULL OR "ceiling" IN ('OPERATIONAL', 'CONTACT_IDENTIFIER', 'COMMUNICATION_CONTENT', 'WORKFORCE_PII'))
    AND ("scope" = 'PROVIDER_POLICY' OR "ceiling" IS NULL)
    AND ("scope" <> 'PROVIDER_POLICY' OR "state" <> 'ACTIVE' OR "ceiling" IS NOT NULL)
    -- PR 1: the operating budget is one platform-wide history, always ACTIVE, and carries its figures
    -- as a JSON object; no other scope carries settings.
    AND ("scope" = 'BUDGET' OR "settings" IS NULL)
    AND ("scope" <> 'BUDGET' OR ("value" = 'operating' AND "state" = 'ACTIVE' AND "settings" IS NOT NULL AND jsonb_typeof("settings") = 'object'))
  );
