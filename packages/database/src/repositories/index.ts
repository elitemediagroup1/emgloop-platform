// Repository layer barrel — Sprint 4 (Real Data Layer) + Sprint 7 (Identity)
// + Sprint 8 (Conversations & the Unified Inbox) + Sprint 9 (Workflows)
// + Sprint 10 (Loop Intelligence Foundation).
//
// One import surface for the whole platform's persistence. The loop engine,
// seed scripts, and API routes depend on these classes, never on the Prisma
// client directly. This keeps queries centralized and testable and preserves
// the architecture: providers handle the OUTSIDE world, repositories handle
// the DATABASE, and the loop engine orchestrates between them.
//
// Sprint 10 adds four new repositories:
//   IntegrationRepository — ProviderConnection + IntegrationEvent CRUD
//   NormalizationEngine   — converts external events into Interaction/Signal/DomainEvent
//   AnalyticsRepository   — foundational KPIs, velocity, and time-series
//   IntelligenceRepository — 3-layer intelligence engine (what/why/next)


import type { PrismaClient } from '@prisma/client';

import { CustomerRepository } from './customer.repository';
import { InteractionRepository } from './interaction.repository';
import { BookingRepository } from './booking.repository';
import { SignalRepository } from './signal.repository';
import { DomainEventRepository } from './domain-event.repository';
import {
  ConversationRepository,
  MessageRepository,
} from './messaging.repository';
import { AIEmployeeRepository } from './ai-employee.repository';
import { CrmRepository } from './crm.repository';
import { AuthRepository } from './auth.repository';
import { IamRepository } from './iam.repository';
import { OrganizationRepository } from './organization.repository';
import { AuditRepository } from './audit.repository';
import { ConversationsRepository } from './conversations.repository';
import { WorkflowsRepository } from './workflows.repository';
// Sprint 10
import { IntegrationRepository } from './integration.repository';
import { NormalizationEngine } from './normalization.repository';
import { AnalyticsRepository } from './analytics.repository';
import { IntelligenceRepository } from './intelligence.repository';

export * from './types';
export {
  CustomerRepository,
  InteractionRepository,
  BookingRepository,
  SignalRepository,
  DomainEventRepository,
  ConversationRepository,
  MessageRepository,
  AIEmployeeRepository,
  CrmRepository,
  AuthRepository,
  IamRepository,
  OrganizationRepository,
  AuditRepository,
  ConversationsRepository,
  WorkflowsRepository,
  // Sprint 10
  IntegrationRepository,
  NormalizationEngine,
  AnalyticsRepository,
  IntelligenceRepository,
};

export type { IntegrationConnectionView, IntegrationEventView, CreateConnectionInput } from './integration.repository';
export type { NormalizationResult } from './normalization.repository';
export type { AnalyticsSummary, VelocityMetrics, AnalyticsTimeSeries } from './analytics.repository';
export type { IntelligenceReport, DescriptiveInsight, DiagnosticInsight, Recommendation } from './intelligence.repository';

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
export { WORKFLOW_TRIGGERS, WORKFLOW_STEP_TYPES } from './workflows.repository';


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
  // Sprint 10
  integrations: IntegrationRepository;
  analytics: AnalyticsRepository;
  intelligence: IntelligenceRepository;
}


/**
 * Build the repository bundle from a Prisma client. Use the shared singleton
 * from `@emgloop/database` in app code; pass a dedicated client for tests.
 * NormalizationEngine is NOT included in the bundle — it is instantiated
 * directly where needed (it takes a WorkflowsRepository dependency).
 */
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
    // Sprint 10
    integrations: new IntegrationRepository(prisma),
    analytics: new AnalyticsRepository(prisma),
    intelligence: new IntelligenceRepository(prisma),
  };
}
