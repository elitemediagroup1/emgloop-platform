-- Loop Cognitive Architecture Foundation (Increment 1).
--
-- Additive-only: 15 new tables + 29 enums + indexes. Introduces the canonical
-- cognitive layer (identity, durable memory, governed knowledge, explainable
-- active state, governance, transactional outbox, subscriptions, hypotheses,
-- decisions). No existing table is altered or dropped (0 ALTER/DROP on prior
-- tables). Validated on clean Postgres both from-zero and from-current-schema.
--
-- NOTE: production applies schema via 'prisma generate' + a deliberate human
-- step, not automatic 'migrate deploy' (there is no _prisma_migrations table in
-- prod). Applying this migration is an intentional action, not a build side effect.

-- CreateEnum
CREATE TYPE "CognitiveEntityType" AS ENUM ('PERSON', 'COMPANY', 'HOUSEHOLD', 'EMPLOYEE', 'CREATOR', 'BUYER', 'VENDOR', 'SOURCE', 'CAMPAIGN', 'PRODUCT', 'SERVICE', 'PROPERTY', 'LOCATION', 'OPPORTUNITY', 'DOCUMENT', 'CALL', 'EMAIL', 'MEETING', 'WORK_ITEM', 'OTHER');

-- CreateEnum
CREATE TYPE "CognitiveIdentityStatus" AS ENUM ('ANONYMOUS', 'KNOWN', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "IdentityRoleType" AS ENUM ('ANONYMOUS_VISITOR', 'KNOWN_VISITOR', 'CONSUMER', 'LEAD', 'CRM_CONTACT', 'BUSINESS_CONTACT', 'CREATOR', 'EMPLOYEE', 'BUYER_CONTACT', 'VENDOR_CONTACT', 'PARTNER', 'CLIENT', 'HOUSEHOLD_MEMBER', 'OTHER');

-- CreateEnum
CREATE TYPE "IdentityRoleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "IdentityEvidenceType" AS ENUM ('AUTHENTICATED_ACCOUNT', 'EMAIL', 'PHONE', 'FIRST_PARTY_COOKIE', 'SESSION_ID', 'DEVICE_ID', 'CALLER_ID', 'FORM_SUBMISSION', 'EXPLICIT_LINK', 'HOUSEHOLD_LINK', 'OTHER');

-- CreateEnum
CREATE TYPE "IdentityResolutionMethod" AS ENUM ('AUTHENTICATED', 'EXPLICIT_LINK', 'VERIFIED_EMAIL', 'VERIFIED_PHONE', 'SESSION_CONTINUITY', 'PSEUDONYMOUS', 'HOUSEHOLD', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "IdentityResolutionStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "MemoryEventType" AS ENUM ('PAGE_VIEWED', 'SEARCH_PERFORMED', 'LINK_CLICKED', 'FORM_SUBMITTED', 'CALL_STARTED', 'CALL_COMPLETED', 'EMAIL_RECEIVED', 'EMAIL_SENT', 'SMS_SENT', 'SMS_RECEIVED', 'PRODUCT_VIEWED', 'PRODUCT_CLICKED', 'PURCHASE_COMPLETED', 'APPOINTMENT_REQUESTED', 'BOOKING_COMPLETED', 'WORK_CREATED', 'WORK_STEP_COMPLETED', 'CAMPAIGN_STATUS_CHANGED', 'CONSENT_CHANGED', 'IDENTITY_LINKED', 'IDENTITY_UNLINKED', 'OTHER');

-- CreateEnum
CREATE TYPE "MemoryProcessingStatus" AS ENUM ('RECEIVED', 'NORMALIZED', 'IDENTITY_RESOLVED', 'MEMORY_PERSISTED', 'STATE_UPDATED', 'PUBLISHED', 'FAILED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "AssertionClass" AS ENUM ('DECLARED', 'OBSERVED', 'INFERRED', 'PREDICTED', 'ORGANIZATIONAL');

-- CreateEnum
CREATE TYPE "AssertionStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CognitiveValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'DATE', 'DATETIME', 'IDENTITY_REFERENCE', 'JSON');

-- CreateEnum
CREATE TYPE "IdentityRelationshipType" AS ENUM ('MEMBER_OF', 'EMPLOYED_BY', 'HOUSEHOLD_MEMBER_OF', 'CONTACT_FOR', 'CREATOR_REPRESENTED_BY', 'BUYER_OF', 'VENDOR_TO', 'PARTNER_OF', 'RELATED_TO', 'INTRODUCED_BY', 'ASSIGNED_TO', 'OWNS', 'MANAGES', 'PARTICIPATED_IN', 'OTHER');

-- CreateEnum
CREATE TYPE "RelationshipStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'INACTIVE', 'REVERSED');

-- CreateEnum
CREATE TYPE "DataPurpose" AS ENUM ('PERSONALIZATION', 'SERVICE_DELIVERY', 'SALES', 'MARKETING', 'ANALYTICS', 'OPERATIONS', 'SUPPORT', 'AI_REASONING', 'AGGREGATION', 'EXTERNAL_ADVERTISING', 'OTHER');

-- CreateEnum
CREATE TYPE "DataSensitivity" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SENSITIVE', 'HIGHLY_SENSITIVE');

-- CreateEnum
CREATE TYPE "DataScope" AS ENUM ('INDIVIDUAL', 'AGGREGATE', 'COMMERCIAL', 'OPERATIONAL', 'INTERNAL', 'PUBLIC');

-- CreateEnum
CREATE TYPE "ConsentBasis" AS ENUM ('CONSENT', 'CONTRACT', 'LEGITIMATE_INTEREST', 'LEGAL_OBLIGATION', 'VITAL_INTEREST', 'PUBLIC_TASK', 'NONE');

-- CreateEnum
CREATE TYPE "GovernancePolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ActiveStateDomain" AS ENUM ('COMMERCE', 'SERVICE_JOURNEY', 'COMMUNICATION', 'RELATIONSHIP', 'SUPPORT', 'COMMERCIAL', 'ACCOUNT', 'RISK', 'OPERATIONAL', 'WORK', 'CAMPAIGN', 'CREATOR', 'OTHER');

-- CreateEnum
CREATE TYPE "ActiveStateStatus" AS ENUM ('ACTIVE', 'STALE', 'EXPIRED', 'SUPPRESSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DecayModel" AS ENUM ('NONE', 'LINEAR', 'EXPONENTIAL', 'FIXED_EXPIRATION', 'RULE_DEFINED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "SubscriberType" AS ENUM ('INTERNAL_HANDLER', 'BRAIN', 'CRM', 'WORK_OS', 'WEBSITE', 'SMS', 'EMAIL', 'CALLGRID_INTELLIGENCE', 'CREATOR_HUB', 'DASHBOARD', 'OTHER');

-- CreateEnum
CREATE TYPE "SubscriptionDeliveryMode" AS ENUM ('INTERNAL_SYNC', 'INTERNAL_ASYNC');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "HypothesisStatus" AS ENUM ('PROPOSED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "HypothesisGeneratedBy" AS ENUM ('DETERMINISTIC_RULE', 'STATISTICAL_MODEL', 'AI_MODEL', 'HUMAN');

-- CreateEnum
CREATE TYPE "DecisionOutcome" AS ENUM ('SEND', 'QUEUE', 'SUPPRESS', 'ESCALATE', 'RECOMMEND', 'CREATE_WORK', 'NO_ACTION');

-- CreateTable
CREATE TABLE "cognitive_identities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entityType" "CognitiveEntityType" NOT NULL,
    "displayName" TEXT,
    "canonicalKey" TEXT NOT NULL,
    "status" "CognitiveIdentityStatus" NOT NULL DEFAULT 'ANONYMOUS',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cognitive_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_roles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "roleType" "IdentityRoleType" NOT NULL,
    "status" "IdentityRoleStatus" NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "sourceEventId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "evidenceType" "IdentityEvidenceType" NOT NULL,
    "normalizedValueHash" TEXT NOT NULL,
    "source" TEXT,
    "confidence" DOUBLE PRECISION,
    "consentBasis" "ConsentBasis" NOT NULL DEFAULT 'NONE',
    "permittedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_resolution_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceIdentityId" TEXT NOT NULL,
    "targetIdentityId" TEXT NOT NULL,
    "method" "IdentityResolutionMethod" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "status" "IdentityResolutionStatus" NOT NULL DEFAULT 'PROPOSED',
    "evidenceSummary" JSONB NOT NULL DEFAULT '{}',
    "consentBasis" "ConsentBasis" NOT NULL DEFAULT 'NONE',
    "permittedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "establishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "establishedBy" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_resolution_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventType" "MemoryEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceSystem" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "actorIdentityId" TEXT,
    "subjectIdentityId" TEXT,
    "objectIdentityId" TEXT,
    "channel" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "sensitivity" "DataSensitivity" NOT NULL DEFAULT 'INTERNAL',
    "consentBasis" "ConsentBasis" NOT NULL DEFAULT 'NONE',
    "permittedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "retentionPolicy" TEXT,
    "aggregationEligibility" BOOLEAN NOT NULL DEFAULT false,
    "processingStatus" "MemoryProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_assertions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subjectIdentityId" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "valueType" "CognitiveValueType" NOT NULL DEFAULT 'STRING',
    "value" JSONB NOT NULL DEFAULT '{}',
    "assertionClass" "AssertionClass" NOT NULL,
    "status" "AssertionStatus" NOT NULL DEFAULT 'PROPOSED',
    "sourceEventId" TEXT,
    "sourceIdentityId" TEXT,
    "confidence" DOUBLE PRECISION,
    "sensitivity" "DataSensitivity" NOT NULL DEFAULT 'INTERNAL',
    "scope" "DataScope" NOT NULL DEFAULT 'INDIVIDUAL',
    "permittedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "consentBasis" "ConsentBasis" NOT NULL DEFAULT 'NONE',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "ownerIdentityId" TEXT,
    "ruleVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_relationships" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromIdentityId" TEXT NOT NULL,
    "toIdentityId" TEXT NOT NULL,
    "relationshipType" "IdentityRelationshipType" NOT NULL,
    "status" "RelationshipStatus" NOT NULL DEFAULT 'ACTIVE',
    "confidence" DOUBLE PRECISION,
    "sourceEventId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "permittedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_governance_policies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "appliesToEntityType" "CognitiveEntityType",
    "appliesToEventType" "MemoryEventType",
    "appliesToAssertionPredicate" TEXT,
    "sensitivity" "DataSensitivity",
    "allowedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "deniedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "allowedChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aggregationAllowed" BOOLEAN NOT NULL DEFAULT false,
    "aiReasoningAllowed" BOOLEAN NOT NULL DEFAULT false,
    "externalDisclosureAllowed" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER,
    "requiresConsent" BOOLEAN NOT NULL DEFAULT false,
    "requiresHumanApproval" BOOLEAN NOT NULL DEFAULT false,
    "status" "GovernancePolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_governance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_state_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "domain" "ActiveStateDomain" NOT NULL,
    "stateKey" TEXT NOT NULL,
    "valueType" "CognitiveValueType" NOT NULL DEFAULT 'STRING',
    "value" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION,
    "status" "ActiveStateStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceEventId" TEXT,
    "lastChangedByEventId" TEXT,
    "calculationRule" TEXT,
    "ruleVersion" TEXT,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "decayModel" "DecayModel" NOT NULL DEFAULT 'NONE',
    "scope" "DataScope" NOT NULL DEFAULT 'INDIVIDUAL',
    "sensitivity" "DataSensitivity" NOT NULL DEFAULT 'INTERNAL',
    "permittedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "active_state_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_state_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "activeStateRecordId" TEXT NOT NULL,
    "memoryEventId" TEXT,
    "knowledgeAssertionId" TEXT,
    "relationshipId" TEXT,
    "weight" DOUBLE PRECISION,
    "contribution" DOUBLE PRECISION,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_state_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_state_revisions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "activeStateRecordId" TEXT NOT NULL,
    "previousValue" JSONB,
    "newValue" JSONB,
    "previousConfidence" DOUBLE PRECISION,
    "newConfidence" DOUBLE PRECISION,
    "changeReason" TEXT,
    "sourceEventId" TEXT,
    "ruleVersion" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_state_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_change_outbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "domain" "ActiveStateDomain" NOT NULL,
    "stateKey" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "activeStateRecordId" TEXT,
    "activeStateRevisionId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "state_change_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_change_subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriberType" "SubscriberType" NOT NULL,
    "subscriberKey" TEXT NOT NULL,
    "domain" "ActiveStateDomain",
    "stateKeyPattern" TEXT,
    "eventTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "minimumConfidence" DOUBLE PRECISION,
    "deliveryMode" "SubscriptionDeliveryMode" NOT NULL DEFAULT 'INTERNAL_SYNC',
    "endpointOrHandler" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "state_change_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence_hypotheses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "hypothesisType" TEXT NOT NULL,
    "subjectIdentityId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "HypothesisStatus" NOT NULL DEFAULT 'PROPOSED',
    "confidence" DOUBLE PRECISION,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "supportingWindowStart" TIMESTAMP(3),
    "supportingWindowEnd" TIMESTAMP(3),
    "scope" "DataScope" NOT NULL DEFAULT 'INDIVIDUAL',
    "sensitivity" "DataSensitivity" NOT NULL DEFAULT 'INTERNAL',
    "permittedPurposes" "DataPurpose"[] DEFAULT ARRAY[]::"DataPurpose"[],
    "generatedBy" "HypothesisGeneratedBy" NOT NULL,
    "ruleVersion" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intelligence_hypotheses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cognitive_decisions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "subjectIdentityId" TEXT,
    "requestedPurpose" "DataPurpose",
    "channel" TEXT,
    "inputStateSnapshot" JSONB NOT NULL DEFAULT '{}',
    "policyEvaluation" JSONB NOT NULL DEFAULT '{}',
    "decision" "DecisionOutcome" NOT NULL,
    "reason" TEXT,
    "confidence" DOUBLE PRECISION,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cognitive_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cognitive_identities_organizationId_entityType_idx" ON "cognitive_identities"("organizationId", "entityType");

-- CreateIndex
CREATE INDEX "cognitive_identities_organizationId_status_idx" ON "cognitive_identities"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cognitive_identities_organizationId_entityType_canonicalKey_key" ON "cognitive_identities"("organizationId", "entityType", "canonicalKey");

-- CreateIndex
CREATE INDEX "identity_roles_organizationId_identityId_idx" ON "identity_roles"("organizationId", "identityId");

-- CreateIndex
CREATE INDEX "identity_roles_organizationId_roleType_status_idx" ON "identity_roles"("organizationId", "roleType", "status");

-- CreateIndex
CREATE INDEX "identity_evidence_organizationId_identityId_idx" ON "identity_evidence"("organizationId", "identityId");

-- CreateIndex
CREATE INDEX "identity_evidence_organizationId_evidenceType_normalizedVal_idx" ON "identity_evidence"("organizationId", "evidenceType", "normalizedValueHash");

-- CreateIndex
CREATE INDEX "identity_resolution_links_organizationId_sourceIdentityId_idx" ON "identity_resolution_links"("organizationId", "sourceIdentityId");

-- CreateIndex
CREATE INDEX "identity_resolution_links_organizationId_targetIdentityId_idx" ON "identity_resolution_links"("organizationId", "targetIdentityId");

-- CreateIndex
CREATE INDEX "identity_resolution_links_organizationId_status_idx" ON "identity_resolution_links"("organizationId", "status");

-- CreateIndex
CREATE INDEX "memory_events_organizationId_subjectIdentityId_occurredAt_idx" ON "memory_events"("organizationId", "subjectIdentityId", "occurredAt");

-- CreateIndex
CREATE INDEX "memory_events_organizationId_eventType_occurredAt_idx" ON "memory_events"("organizationId", "eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "memory_events_organizationId_processingStatus_idx" ON "memory_events"("organizationId", "processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "memory_events_organizationId_sourceSystem_sourceEventId_key" ON "memory_events"("organizationId", "sourceSystem", "sourceEventId");

-- CreateIndex
CREATE INDEX "knowledge_assertions_organizationId_subjectIdentityId_predi_idx" ON "knowledge_assertions"("organizationId", "subjectIdentityId", "predicate", "status");

-- CreateIndex
CREATE INDEX "knowledge_assertions_organizationId_status_expiresAt_idx" ON "knowledge_assertions"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "identity_relationships_organizationId_fromIdentityId_relati_idx" ON "identity_relationships"("organizationId", "fromIdentityId", "relationshipType");

-- CreateIndex
CREATE INDEX "identity_relationships_organizationId_toIdentityId_relation_idx" ON "identity_relationships"("organizationId", "toIdentityId", "relationshipType");

-- CreateIndex
CREATE INDEX "data_governance_policies_organizationId_status_idx" ON "data_governance_policies"("organizationId", "status");

-- CreateIndex
CREATE INDEX "data_governance_policies_organizationId_appliesToEntityType_idx" ON "data_governance_policies"("organizationId", "appliesToEntityType");

-- CreateIndex
CREATE INDEX "data_governance_policies_organizationId_appliesToEventType_idx" ON "data_governance_policies"("organizationId", "appliesToEventType");

-- CreateIndex
CREATE INDEX "active_state_records_organizationId_identityId_domain_idx" ON "active_state_records"("organizationId", "identityId", "domain");

-- CreateIndex
CREATE INDEX "active_state_records_organizationId_domain_stateKey_status_idx" ON "active_state_records"("organizationId", "domain", "stateKey", "status");

-- CreateIndex
CREATE INDEX "active_state_records_organizationId_expiresAt_idx" ON "active_state_records"("organizationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "active_state_records_organizationId_identityId_domain_state_key" ON "active_state_records"("organizationId", "identityId", "domain", "stateKey");

-- CreateIndex
CREATE INDEX "active_state_evidence_organizationId_activeStateRecordId_idx" ON "active_state_evidence"("organizationId", "activeStateRecordId");

-- CreateIndex
CREATE INDEX "active_state_revisions_organizationId_activeStateRecordId_c_idx" ON "active_state_revisions"("organizationId", "activeStateRecordId", "changedAt");

-- CreateIndex
CREATE INDEX "state_change_outbox_organizationId_status_availableAt_idx" ON "state_change_outbox"("organizationId", "status", "availableAt");

-- CreateIndex
CREATE INDEX "state_change_subscriptions_organizationId_status_idx" ON "state_change_subscriptions"("organizationId", "status");

-- CreateIndex
CREATE INDEX "state_change_subscriptions_organizationId_domain_status_idx" ON "state_change_subscriptions"("organizationId", "domain", "status");

-- CreateIndex
CREATE INDEX "intelligence_hypotheses_organizationId_status_idx" ON "intelligence_hypotheses"("organizationId", "status");

-- CreateIndex
CREATE INDEX "intelligence_hypotheses_organizationId_subjectIdentityId_st_idx" ON "intelligence_hypotheses"("organizationId", "subjectIdentityId", "status");

-- CreateIndex
CREATE INDEX "cognitive_decisions_organizationId_decisionType_idx" ON "cognitive_decisions"("organizationId", "decisionType");

-- CreateIndex
CREATE INDEX "cognitive_decisions_organizationId_subjectIdentityId_idx" ON "cognitive_decisions"("organizationId", "subjectIdentityId");

