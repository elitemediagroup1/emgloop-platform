// Repository layer barrel — Sprint 4 (Real Data Layer) + Sprint 7 (Identity)
// + Sprint 8 (Conversations & the Unified Inbox) + Sprint 9 (Workflows)
// + Sprint 10 (Loop Intelligence Foundation) + Sprint 14 (Website Intelligence)
// + Sprint 15 (Live Operations, Traffic & Revenue Intelligence)
// + Verified Knowledge Service (kg.v1 — distinct from RAG/embeddings).
//
// One import surface for the whole platform's persistence.

import type { PrismaClient } from '@prisma/client';

import { CustomerRepository } from './customer.repository';
import { InteractionRepository } from './interaction.repository';
import { BookingRepository } from './booking.repository';
import { SignalRepository } from './signal.repository';
import { DomainEventRepository } from './domain-event.repository';
import { LoopEventRepository } from './loop-event.repository';
import { ConversationRepository, MessageRepository } from './messaging.repository';
import { AIEmployeeRepository } from './ai-employee.repository';
import { CrmRepository } from './crm.repository';
import { AuthRepository } from './auth.repository';
import { IamRepository } from './iam.repository';
import { OrganizationRepository } from './organization.repository';
import { AuditRepository } from './audit.repository';
import { ConversationsRepository } from './conversations.repository';
import { WorkflowsRepository } from './workflows.repository';
import { IntegrationRepository } from './integration.repository';
import { NormalizationEngine } from './normalization.repository';
import { AnalyticsRepository } from './analytics.repository';
import { WebsiteAnalyticsRepository } from './website-analytics.repository';
import { IntelligenceRepository } from './intelligence.repository';
import { LiveOperationsRepository } from './live-operations.repository';
import { RevenueIntelligenceRepository } from './revenue-intelligence.repository';
import { WorkRepository } from './work.repository';
import { VerifiedKnowledgeRepository } from './verified-knowledge.repository';
import { MarketplaceCallRepository } from './marketplace-call.repository';
import { BusinessProcessRepository } from '../process-engine/business-process.repository';

export * from './types';
export { CustomerRepository, customerDisplayName } from './customer.repository';
export { InteractionRepository } from './interaction.repository';
export { BookingRepository } from './booking.repository';
export { SignalRepository, signalTypeFromLabel } from './signal.repository';
export { DomainEventRepository } from './domain-event.repository';
export { LoopEventRepository } from './loop-event.repository';
export { ConversationRepository, MessageRepository } from './messaging.repository';
export { AIEmployeeRepository } from './ai-employee.repository';
export type { AIEmployeeView } from './ai-employee.repository';
export { CrmRepository, PIPELINE_STATUSES } from './crm.repository';
export type {
  PipelineStatus,
  CustomerSortKey,
  CustomerListFilters,
  CustomerListRow,
  CustomerListResult,
  AssigneeOption,
  AssigneeOptions,
  InboxItem,
  KanbanColumn,
} from './crm.repository';
export { AuthRepository } from './auth.repository';
export type { SessionWithUser } from './auth.repository';
export {
  IamRepository,
  SYSTEM_ROLES,
  SYSTEM_ROLE_LABELS,
  roleLabel,
  matrixAllows,
  userSystemRole,
} from './iam.repository';
export type { Resource, Action, UserListItem } from './iam.repository';
export { OrganizationRepository } from './organization.repository';
export type { OrgSummary, OrgBranding, OrgCrmDefaults } from './organization.repository';
export { AuditRepository } from './audit.repository';
export type { AuditView } from './audit.repository';
export { ConversationsRepository, CONVERSATION_STATUSES } from './conversations.repository';
export type {
  InboxFilters,
  ConversationListItem,
  ConversationListResult,
  ThreadMessage,
  ConversationWorkspace,
  SavedView,
  MergeResult,
  DuplicateGroup,
} from './conversations.repository';
export { WorkflowsRepository, WORKFLOW_TRIGGERS, WORKFLOW_STEP_TYPES } from './workflows.repository';
export type {
  WorkflowStepType,
  WorkflowStep,
  WorkflowDefinition,
  TriggerConfig,
  WorkflowListItem,
  WorkflowDetail,
  WorkflowRunView,
  StepResult,
  RunContext,
  RunOutcome,
} from './workflows.repository';
export { IntegrationRepository } from './integration.repository';
export type { IntegrationConnectionView, IntegrationEventView, CreateConnectionInput } from './integration.repository';
export { NormalizationEngine } from './normalization.repository';
export type { NormalizationResult } from './normalization.repository';
export { AnalyticsRepository } from './analytics.repository';
export type { AnalyticsSummary, VelocityMetrics, AnalyticsTimeSeries } from './analytics.repository';
export { WebsiteAnalyticsRepository } from './website-analytics.repository';
export type { WebsiteAnalytics, WebsiteRankedItem } from './website-analytics.repository';
export { IntelligenceRepository } from './intelligence.repository';
export type { IntelligenceReport, DescriptiveInsight, DiagnosticInsight, Recommendation } from './intelligence.repository';
export { LiveOperationsRepository } from './live-operations.repository';
export type {
  LiveActivityItem,
  LiveActivityKind,
  LiveCallRow,
  LiveWebsiteRow,
  LiveWebsiteSession,
  BrainCallWindowRow,
  BrainCallWindowFilters,
} from './live-operations.repository';
export { RevenueIntelligenceRepository } from './revenue-intelligence.repository';
export type {
  QueryCoverage,
  RankedRevenue,
  RevenueByDimension,
  TrafficVendorRow,
  TrafficSourceRow,
  TrafficCampaignRow,
  TrafficBuyerRow,
  TrafficIntelligence,
  RevenueTimelineEntry,
  CustomerRevenueTimeline,
} from './revenue-intelligence.repository';

// Sprint 15 hotfix — production-safe operational filters (test-data exclusion,
// honest attribution, EMG properties, recency windows). Additive only.
export * from './operational-filters';

// PR #75 — Work OS Blueprint Runtime v1 (concrete execution runtime).
export {
  WorkRepository,
  BLUEPRINT_STATUSES,
  WORK_INSTANCE_STATUSES,
  WORK_STAGE_STATUSES,
  WORK_NOTIFICATION_TYPES,
} from './work.repository';
export type {
  BlueprintStatus,
  WorkInstanceStatus,
  WorkStageStatus,
  WorkNotificationType,
  CreateBlueprintInput,
  CreateBlueprintStageInput,
  CreateWorkFromBlueprintInput,
  CompleteCurrentStageInput,
  AssignStageInput,
  AddWorkCommentInput,
  WorkInstanceWithStages,
} from './work.repository';

// Verified Knowledge Service (kg.v1) — durable verified knowledge graph,
// distinct from the embedding / RAG document store. Additive only.
export { VerifiedKnowledgeRepository } from './verified-knowledge.repository';
export type { ImportOutcome } from './verified-knowledge.repository';

// MarketplaceCall — sensor-neutral operational call projection for Intelligence.
export { MarketplaceCallRepository, aggregateRows } from './marketplace-call.repository';
export type { CallWindowAggregate, CallDimensionAggregate, BackfillResult } from './marketplace-call.repository';
export {
  projectInteractionToMarketplaceCall,
} from './marketplace-call-projection';
export type {
  MarketplaceCallProjection,
  InteractionForProjection,
} from './marketplace-call-projection';

export interface Repositories {
  customers: CustomerRepository;
  interactions: InteractionRepository;
  bookings: BookingRepository;
  signals: SignalRepository;
  domainEvents: DomainEventRepository;
  loopEvents: LoopEventRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  aiEmployees: AIEmployeeRepository;
  crm: CrmRepository;
  auth: AuthRepository;
  iam: IamRepository;
  organizations: OrganizationRepository;
  audit: AuditRepository;
  conversationsInbox: ConversationsRepository;
  workflows: WorkflowsRepository;
  integrations: IntegrationRepository;
  analytics: AnalyticsRepository;
  websiteAnalytics: WebsiteAnalyticsRepository;
  intelligence: IntelligenceRepository;
  liveOperations: LiveOperationsRepository;
  revenueIntelligence: RevenueIntelligenceRepository;
  work: WorkRepository;
  verifiedKnowledge: VerifiedKnowledgeRepository;
  marketplaceCalls: MarketplaceCallRepository;
  // Sprint 27D — Business Process Engine runtime (PR B). Persistence + projection.
  businessProcess: BusinessProcessRepository;
}

export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    customers: new CustomerRepository(prisma),
    interactions: new InteractionRepository(prisma),
    bookings: new BookingRepository(prisma),
    signals: new SignalRepository(prisma),
    domainEvents: new DomainEventRepository(prisma),
    loopEvents: new LoopEventRepository(prisma),
    conversations: new ConversationRepository(prisma),
    messages: new MessageRepository(prisma),
    aiEmployees: new AIEmployeeRepository(prisma),
    crm: new CrmRepository(prisma),
    auth: new AuthRepository(prisma),
    iam: new IamRepository(prisma),
    organizations: new OrganizationRepository(prisma),
    audit: new AuditRepository(prisma),
    conversationsInbox: new ConversationsRepository(prisma),
    workflows: new WorkflowsRepository(prisma),
    integrations: new IntegrationRepository(prisma),
    analytics: new AnalyticsRepository(prisma),
    websiteAnalytics: new WebsiteAnalyticsRepository(prisma),
    intelligence: new IntelligenceRepository(prisma),
    liveOperations: new LiveOperationsRepository(prisma),
    revenueIntelligence: new RevenueIntelligenceRepository(prisma),
    work: new WorkRepository(prisma),
    verifiedKnowledge: new VerifiedKnowledgeRepository(prisma),
    marketplaceCalls: new MarketplaceCallRepository(prisma),
    businessProcess: new BusinessProcessRepository(prisma),
  };
}
