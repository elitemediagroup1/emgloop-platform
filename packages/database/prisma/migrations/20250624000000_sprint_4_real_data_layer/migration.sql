-- Sprint 4 — Real Data Layer: initial migration for the EMG Loop schema.
-- Generated to match packages/database/prisma/schema.prisma, including the
-- Sprint 4 internal domain_events fact log. Apply in production with
--   prisma migrate deploy   (NOT run automatically from this commit).

-- CreateEnum
CREATE TYPE "IndustryType" AS ENUM ('HOME_SERVICES', 'NAIL_SALON', 'BARBERSHOP', 'MEDICAL', 'DENTAL', 'RESTAURANT', 'PIZZERIA', 'LAW_FIRM', 'AUTOMOTIVE', 'BEAUTY_SPA', 'FITNESS', 'GENERIC');
CREATE TYPE "OrganizationStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED');
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');
CREATE TYPE "ChannelType" AS ENUM ('PHONE', 'SMS', 'EMAIL', 'WEB_CHAT', 'WHATSAPP', 'IN_PERSON', 'SOCIAL', 'OTHER');
CREATE TYPE "InteractionDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'SNOOZED', 'CLOSED');
CREATE TYPE "ActorType" AS ENUM ('CUSTOMER', 'HUMAN_AGENT', 'AI_AGENT', 'SYSTEM');
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'AUDIO', 'IMAGE', 'FILE', 'TRANSCRIPT', 'EVENT', 'SYSTEM');
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELED');
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PLACED', 'IN_PROGRESS', 'READY', 'FULFILLED', 'CANCELED', 'REFUNDED');
CREATE TYPE "FulfillmentType" AS ENUM ('PICKUP', 'DELIVERY', 'DINE_IN', 'ON_SITE', 'REMOTE');
CREATE TYPE "ServiceRequestStatus" AS ENUM ('NEW', 'QUALIFYING', 'QUOTED', 'WON', 'LOST', 'ON_HOLD');
CREATE TYPE "SignalType" AS ENUM ('INTENT', 'SENTIMENT', 'CHURN_RISK', 'UPSELL_OPPORTUNITY', 'LIFETIME_VALUE', 'NO_SHOW_RISK', 'SATISFACTION', 'LANGUAGE', 'TOPIC', 'CUSTOM');
CREATE TYPE "WorkflowTrigger" AS ENUM ('EVENT', 'SCHEDULE', 'MANUAL', 'WEBHOOK', 'SIGNAL');
CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');
CREATE TYPE "AIAgentType" AS ENUM ('PHONE', 'SMS', 'CHAT', 'ORDER_TAKING', 'RECEPTIONIST', 'FOLLOW_UP', 'CUSTOM');
CREATE TYPE "ProviderCategory" AS ENUM ('AI', 'VOICE', 'SMS', 'EMAIL', 'PAYMENT', 'CALENDAR');
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED');
CREATE TYPE "IntegrationEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');
CREATE TYPE "SystemRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'AI_EMPLOYEE', 'READ_ONLY');
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');
CREATE TYPE "AuthProviderType" AS ENUM ('PASSWORD', 'GOOGLE_OAUTH', 'MICROSOFT_OAUTH', 'SAML_SSO', 'OIDC_SSO', 'MAGIC_LINK');
CREATE TYPE "CapabilityStatus" AS ENUM ('AVAILABLE', 'ENABLED', 'CONFIGURED', 'PAUSED', 'DISABLED');
CREATE TYPE "PermissionEffect" AS ENUM ('ALLOW', 'DENY');
CREATE TYPE "InteractionKind" AS ENUM ('PHONE_CALL', 'SMS', 'EMAIL', 'CHAT', 'RESERVATION', 'APPOINTMENT', 'ORDER', 'FORM_SUBMISSION', 'REVIEW', 'PAYMENT', 'NOTE', 'OTHER');
CREATE TYPE "AIEmployeeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE "PermissionSubjectType" AS ENUM ('HUMAN_USER', 'AI_EMPLOYEE', 'SYSTEM_PROCESS');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "industry" "IndustryType" NOT NULL DEFAULT 'GENERIC',
    "status" "OrganizationStatus" NOT NULL DEFAULT 'TRIAL',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "sourceKey" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "phone" TEXT,
    "email" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "hours" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "roleId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "authProvider" TEXT,
    "externalAuthId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "externalId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "locale" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "interactions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT,
    "conversationId" TEXT,
    "channel" "ChannelType" NOT NULL,
    "kind" "InteractionKind" NOT NULL DEFAULT 'OTHER',
    "direction" "InteractionDirection" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT,
    "provider" TEXT,
    "externalId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT,
    "assigneeId" TEXT,
    "aiAgentId" TEXT,
    "channel" "ChannelType" NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "provider" TEXT,
    "externalId" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT,
    "customerId" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "title" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "partySize" INTEGER,
    "calendarProvider" TEXT,
    "calendarEventId" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT,
    "customerId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "fulfillment" "FulfillmentType" NOT NULL DEFAULT 'PICKUP',
    "number" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "items" JSONB NOT NULL DEFAULT '[]',
    "paymentProvider" TEXT,
    "paymentExternalId" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT,
    "customerId" TEXT,
    "status" "ServiceRequestStatus" NOT NULL DEFAULT 'NEW',
    "source" TEXT,
    "category" TEXT,
    "summary" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "estimatedValueCents" INTEGER,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT,
    "conversationId" TEXT,
    "type" "SignalType" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "valueNumber" DOUBLE PRECISION,
    "valueString" TEXT,
    "confidence" DOUBLE PRECISION,
    "source" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "WorkflowTrigger" NOT NULL DEFAULT 'EVENT',
    "triggerConfig" JSONB NOT NULL DEFAULT '{}',
    "definition" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
    "triggeredBy" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_agents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT,
    "voiceProfileId" TEXT,
    "name" TEXT NOT NULL,
    "type" "AIAgentType" NOT NULL DEFAULT 'CHAT',
    "modelProvider" TEXT,
    "model" TEXT,
    "systemPrompt" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_employees" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT,
    "voiceProfileId" TEXT,
    "agentId" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "status" "AIEmployeeStatus" NOT NULL DEFAULT 'DRAFT',
    "channels" "ChannelType"[],
    "inheritsDNA" BOOLEAN NOT NULL DEFAULT true,
    "dnaOverrides" JSONB NOT NULL DEFAULT '{}',
    "knowledgeAccess" JSONB NOT NULL DEFAULT '{}',
    "escalationRules" JSONB NOT NULL DEFAULT '{}',
    "operatingHours" JSONB NOT NULL DEFAULT '{}',
    "providerPrefs" JSONB NOT NULL DEFAULT '{}',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_employees_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "voice_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "voiceProvider" TEXT,
    "voiceId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "gender" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "voice_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "category" "ProviderCategory" NOT NULL,
    "provider" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "externalAccountId" TEXT,
    "credentialsRef" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "integration_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerConnectionId" TEXT,
    "category" "ProviderCategory",
    "provider" TEXT,
    "eventType" TEXT NOT NULL,
    "externalId" TEXT,
    "status" "IntegrationEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "modules" JSONB NOT NULL DEFAULT '{}',
    "limits" JSONB NOT NULL DEFAULT '{}',
    "featureFlags" JSONB NOT NULL DEFAULT '{}',
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_preferences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "dateFormat" TEXT NOT NULL DEFAULT 'MM/DD/YYYY',
    "timeFormat" TEXT NOT NULL DEFAULT '12h',
    "weekStart" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "notifications" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organization_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_dna" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "industry" "IndustryType" NOT NULL DEFAULT 'GENERIC',
    "brand" JSONB NOT NULL DEFAULT '{}',
    "voice" JSONB NOT NULL DEFAULT '{}',
    "communicationStyle" JSONB NOT NULL DEFAULT '{}',
    "businessHours" JSONB NOT NULL DEFAULT '{}',
    "knowledgeSources" JSONB NOT NULL DEFAULT '[]',
    "complianceRules" JSONB NOT NULL DEFAULT '{}',
    "escalationRules" JSONB NOT NULL DEFAULT '{}',
    "aiDefaults" JSONB NOT NULL DEFAULT '{}',
    "providerDefaults" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organization_dna_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invitedById" TEXT,
    "email" TEXT NOT NULL,
    "systemRole" "SystemRole" NOT NULL DEFAULT 'EMPLOYEE',
    "roleId" TEXT,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "password_resets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authProvider" "AuthProviderType" NOT NULL DEFAULT 'PASSWORD',
    "tokenHash" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "systemRole" "SystemRole",
    "subjectType" "PermissionSubjectType" NOT NULL DEFAULT 'HUMAN_USER',
    "roleId" TEXT,
    "userId" TEXT,
    "aiEmployeeId" TEXT,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL DEFAULT 'ALLOW',
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "capabilities" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "dependencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "configSchema" JSONB NOT NULL DEFAULT '{}',
    "isCore" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "capabilities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_capabilities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "capabilityKey" TEXT NOT NULL,
    "status" "CapabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabledAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organization_capabilities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "domain_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aggregateType" TEXT,
    "aggregateId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");
CREATE INDEX "organizations_sourceKey_idx" ON "organizations"("sourceKey");
CREATE INDEX "locations_organizationId_idx" ON "locations"("organizationId");
CREATE UNIQUE INDEX "locations_organizationId_slug_key" ON "locations"("organizationId", "slug");
CREATE INDEX "roles_organizationId_idx" ON "roles"("organizationId");
CREATE UNIQUE INDEX "roles_organizationId_name_key" ON "roles"("organizationId", "name");
CREATE INDEX "users_organizationId_idx" ON "users"("organizationId");
CREATE INDEX "users_externalAuthId_idx" ON "users"("externalAuthId");
CREATE UNIQUE INDEX "users_organizationId_email_key" ON "users"("organizationId", "email");
CREATE INDEX "customers_organizationId_idx" ON "customers"("organizationId");
CREATE INDEX "customers_organizationId_email_idx" ON "customers"("organizationId", "email");
CREATE INDEX "customers_organizationId_phone_idx" ON "customers"("organizationId", "phone");
CREATE UNIQUE INDEX "customers_organizationId_externalId_key" ON "customers"("organizationId", "externalId");
CREATE INDEX "interactions_organizationId_occurredAt_idx" ON "interactions"("organizationId", "occurredAt");
CREATE INDEX "interactions_organizationId_kind_idx" ON "interactions"("organizationId", "kind");
CREATE INDEX "interactions_customerId_idx" ON "interactions"("customerId");
CREATE INDEX "interactions_conversationId_idx" ON "interactions"("conversationId");
CREATE INDEX "conversations_organizationId_status_idx" ON "conversations"("organizationId", "status");
CREATE INDEX "conversations_customerId_idx" ON "conversations"("customerId");
CREATE INDEX "messages_conversationId_sentAt_idx" ON "messages"("conversationId", "sentAt");
CREATE INDEX "messages_organizationId_idx" ON "messages"("organizationId");
CREATE INDEX "bookings_organizationId_startAt_idx" ON "bookings"("organizationId", "startAt");
CREATE INDEX "bookings_customerId_idx" ON "bookings"("customerId");
CREATE INDEX "orders_organizationId_status_idx" ON "orders"("organizationId", "status");
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");
CREATE UNIQUE INDEX "orders_organizationId_number_key" ON "orders"("organizationId", "number");
CREATE INDEX "service_requests_organizationId_status_idx" ON "service_requests"("organizationId", "status");
CREATE INDEX "service_requests_customerId_idx" ON "service_requests"("customerId");
CREATE INDEX "signals_organizationId_type_idx" ON "signals"("organizationId", "type");
CREATE INDEX "signals_customerId_type_idx" ON "signals"("customerId", "type");
CREATE INDEX "workflows_organizationId_isActive_idx" ON "workflows"("organizationId", "isActive");
CREATE INDEX "workflow_runs_organizationId_status_idx" ON "workflow_runs"("organizationId", "status");
CREATE INDEX "workflow_runs_workflowId_idx" ON "workflow_runs"("workflowId");
CREATE INDEX "ai_agents_organizationId_type_idx" ON "ai_agents"("organizationId", "type");
CREATE INDEX "ai_employees_organizationId_status_idx" ON "ai_employees"("organizationId", "status");
CREATE INDEX "ai_employees_organizationId_locationId_idx" ON "ai_employees"("organizationId", "locationId");
CREATE INDEX "voice_profiles_organizationId_idx" ON "voice_profiles"("organizationId");
CREATE INDEX "provider_connections_organizationId_category_idx" ON "provider_connections"("organizationId", "category");
CREATE UNIQUE INDEX "provider_connections_organizationId_category_provider_key" ON "provider_connections"("organizationId", "category", "provider");
CREATE INDEX "integration_events_organizationId_status_idx" ON "integration_events"("organizationId", "status");
CREATE INDEX "integration_events_providerConnectionId_idx" ON "integration_events"("providerConnectionId");
CREATE UNIQUE INDEX "integration_events_provider_externalId_key" ON "integration_events"("provider", "externalId");
CREATE INDEX "audit_logs_organizationId_createdAt_idx" ON "audit_logs"("organizationId", "createdAt");
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");
CREATE UNIQUE INDEX "organization_settings_organizationId_key" ON "organization_settings"("organizationId");
CREATE UNIQUE INDEX "organization_preferences_organizationId_key" ON "organization_preferences"("organizationId");
CREATE UNIQUE INDEX "organization_dna_organizationId_key" ON "organization_dna"("organizationId");
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");
CREATE INDEX "invitations_organizationId_status_idx" ON "invitations"("organizationId", "status");
CREATE INDEX "invitations_email_idx" ON "invitations"("email");
CREATE UNIQUE INDEX "password_resets_tokenHash_key" ON "password_resets"("tokenHash");
CREATE INDEX "password_resets_userId_idx" ON "password_resets"("userId");
CREATE UNIQUE INDEX "user_sessions_tokenHash_key" ON "user_sessions"("tokenHash");
CREATE INDEX "user_sessions_userId_idx" ON "user_sessions"("userId");
CREATE INDEX "user_sessions_organizationId_idx" ON "user_sessions"("organizationId");
CREATE INDEX "permissions_organizationId_resource_action_idx" ON "permissions"("organizationId", "resource", "action");
CREATE UNIQUE INDEX "capabilities_key_key" ON "capabilities"("key");
CREATE INDEX "organization_capabilities_organizationId_status_idx" ON "organization_capabilities"("organizationId", "status");
CREATE UNIQUE INDEX "organization_capabilities_organizationId_capabilityId_key" ON "organization_capabilities"("organizationId", "capabilityId");
CREATE INDEX "domain_events_organizationId_occurredAt_idx" ON "domain_events"("organizationId", "occurredAt");
CREATE INDEX "domain_events_organizationId_name_idx" ON "domain_events"("organizationId", "name");
CREATE INDEX "domain_events_aggregateType_aggregateId_idx" ON "domain_events"("aggregateType", "aggregateId");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roles" ADD CONSTRAINT "roles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_aiAgentId_fkey" FOREIGN KEY ("aiAgentId") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "signals" ADD CONSTRAINT "signals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signals" ADD CONSTRAINT "signals_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "signals" ADD CONSTRAINT "signals_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_voiceProfileId_fkey" FOREIGN KEY ("voiceProfileId") REFERENCES "voice_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_voiceProfileId_fkey" FOREIGN KEY ("voiceProfileId") REFERENCES "voice_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_preferences" ADD CONSTRAINT "organization_preferences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_dna" ADD CONSTRAINT "organization_dna_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_aiEmployeeId_fkey" FOREIGN KEY ("aiEmployeeId") REFERENCES "ai_employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_capabilities" ADD CONSTRAINT "organization_capabilities_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
