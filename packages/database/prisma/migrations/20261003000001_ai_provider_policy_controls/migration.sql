-- AI provider policy as a RECORDED CONTROL (activation gate G2), 2026-09-24.
--
-- ADDITIVE ONLY. One nullable column on ai_controls ("ceiling"), and the ai_controls_shape CHECK
-- re-stated with one more permitted scope (PROVIDER_POLICY) and the rules for the new column.
-- Every row the old constraint accepted, the new one accepts: existing rows carry a NULL ceiling
-- and one of the five switch scopes. No row is read, written or moved. Safe to apply to a live
-- database.
--
-- WHY. G2 ("this provider's data terms were confirmed") used to be an environment variable,
-- LOOP_AI_PROVIDER_TERMS_CONFIRMED, and the connections stack set it automatically whenever it
-- listed a provider -- so listing a provider implied approving it. From now on the approval is a
-- stored, versioned, audited control: scope PROVIDER_POLICY, value = the provider id, "ceiling" =
-- the highest sensitivity class Loop may send it, with a required reason and a named actor (a
-- person, or an operations run). The gateway refuses a provider without a current ACTIVE policy
-- whose ceiling reaches the task's own (docs/architecture/loop-ai-runtime.md G2).
--
-- ITS OWN KEY NAMESPACE. The key derivation is unchanged ("scope"|org|value), so a provider policy
-- is `PROVIDER_POLICY|-|<provider>` and can never share a history with the PROVIDER activation
-- control `PROVIDER|-|<provider>`.
--
-- DEPLOYMENT ORDER. Code that reads provider policies refuses every AI call until a policy is
-- recorded. Apply this migration, record the policy (record-ai-provider-policy workflow), THEN
-- deploy the code -- or AI work is refused (held, not dropped) until the policy exists.
--
-- The constraint is dropped and re-added rather than altered because Postgres has no ALTER
-- CONSTRAINT for a CHECK; both statements run in the one migration transaction.
--
-- ASCII only: an em-dash in a migration once blocked replay of an entire ledger.

-- AlterTable
ALTER TABLE "ai_controls" ADD COLUMN "ceiling" TEXT;

ALTER TABLE "ai_controls" DROP CONSTRAINT "ai_controls_shape";

ALTER TABLE "ai_controls" ADD CONSTRAINT "ai_controls_shape"
  CHECK (
    "scope" IN ('GLOBAL', 'PROVIDER', 'MODEL', 'TASK', 'ORGANIZATION', 'PROVIDER_POLICY')
    AND "state" IN ('ACTIVE', 'KILLED')
    AND "version" >= 1
    AND "controlKey" = "scope" || '|' || coalesce("organizationId", '-') || '|' || coalesce("value", '-')
    AND ("scope" NOT IN ('GLOBAL', 'PROVIDER', 'MODEL', 'PROVIDER_POLICY') OR "organizationId" IS NULL)
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
  );
