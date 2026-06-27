// Repository layer barrel — Sprint 4 (Real Data Layer) + Sprint 7 (Identity)
// + Sprint 8 (Conversations & the Unified Inbox) + Sprint 9 (Workflows)
// + Sprint 10 (Loop Intelligence Foundation) + Sprint 14 (Website Intelligence)
// + Sprint 15 (Live Operations, Traffic & Revenue Intelligence).
//
// One import surface for the whole platform's persistence.

import type { PrismaClient } from '@prisma/client';

import { CustomerRepository } from './customer.repository';
import { InteractionRepository } from './interaction.repository';
import { BookingRepository } from './booking.repository';
import { SignalRepository } from './signal.repository';
import { DomainEventRepository } from './domain-event.repository';
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

export * from './types';
export { CustomerRepository } from './customer.repository';
export { InteractionRepository } from './interaction.repository';
export { BookingRepository } from './booking.repository';
export { SignalRepository } from './signal.repository';
export { DomainEventRepository } from './domain-event.repository';
export { ConversationRepository, MessageRepository } from './messaging.repository';
export { AIEmployeeRepository } from './ai-employee.repository';
export { CrmRepository } from './crm.repository';
export { AuthRepository } from './auth.repository';
export { IamRepository } from './iam.repository';
export { OrganizationRepository } from './organization.repository';
export { AuditRepository } from './audit.repository';
export { ConversationsRepository } from './conversations.repository';
export { WorkflowsRepository } from './workflows.repository';
export type {
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
} from './live-operations.repository';
export { RevenueIntelligenceRepository } from './revenue-intelligence.repository';
export type {
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

export interface Repositories {
  customers: CustomerRepository;
  interactions: InteractionRepository;
  bookings: BookingRepository;
  signals: SignalRepository;
  domainEvents: DomainEventRepository;
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
}

export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    customers: new CustomerRepository(prisma),
    interactions: new InteractionRepository(prisma),
    bookings: new BookingRepository(prisma),
    signals: new SignalRepository(prisma),
    domainEvents: new DomainEventRepository(prisma),
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
  };
}
