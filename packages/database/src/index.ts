// @emgloop/database
//
// Single source of the Prisma client for the whole platform.
// A singleton avoids exhausting Postgres connections in dev / serverless.

import { PrismaClient } from '@prisma/client';
import { createRepositories, type Repositories } from './repositories';
import { runWithReconnect } from './connection-resilience';

declare global {
    // eslint-disable-next-line no-var
  var __emgloopPrisma: PrismaClient | undefined;
}

const basePrisma: PrismaClient =
    global.__emgloopPrisma ??
    new PrismaClient({
          log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
    });

// Serverless containers stay warm across invocations, so this client outlives a
// single request and can be holding a socket that Postgres already closed —
// Neon suspends an idle compute and drops its connections. The next query then
// fails with `kind: Closed` before any application logic runs, which is exactly
// how the CallGrid reconciliation route failed in production.
//
// Applied once here rather than at call sites: a per-route guard would leave
// every other route exposed to the same failure. The retry is narrow (only
// connection loss) and single (no loop), so a genuine outage still surfaces.
export const prisma: PrismaClient = basePrisma.$extends({
  name: 'reconnect-on-closed',
  query: {
    async $allOperations({ args, query }) {
      return runWithReconnect(
        () => query(args),
        async () => {
          // Drop the dead socket before asking for a new one. $disconnect() here
          // is recovery, never part of the happy path.
          await basePrisma.$disconnect().catch(() => undefined);
          await basePrisma.$connect();
        },
      );
    },
  },
}) as unknown as PrismaClient;

if (process.env.NODE_ENV !== 'production') {
    global.__emgloopPrisma = basePrisma;
}

export * from './connection-resilience';
export * from './repositories';
export * from './integration-catalog';

// Loop Cognitive Architecture — event processing pipeline (Increment 2).
// Server-only; built on the Increment 1 cognitive repositories.
export * from './services/cognitive';
// The Decision Engine — the canonical producer-facing service for turning
// intelligence into durable operational decisions. Producers use THIS, never the
// underlying repositories: reaching past it bypasses the transaction boundary,
// the projection and the outbox publication in one go.
export * from './services/decision';
import { createDecisionEngine } from './services/decision';

// Commercial Intelligence Stage 2 — evaluating observable activity against
// Performance Objectives. Reads two domains, writes only commercial_signals,
// and does nothing downstream: no headline, no decision, no work, no event.
export { CommercialSignalEvaluationService, COMMERCIAL_SIGNAL_MAX_OBSERVATIONS } from './services/commercial-signal-evaluation.service';
export type { EvaluationRunSummary, EvaluationRunOptions } from './services/commercial-signal-evaluation.service';

// Commercial Intelligence Stage 3 v1 — turning a confirmed measure binding into a
// measured development. Reads objectives, bindings and call AGGREGATES; writes
// only `headlines`. It reads no Commercial Signal, and it does nothing
// downstream: no decision, no evidence, no work item, no notification, no event.
export { HeadlineDetectionService } from './services/headline-detection.service';
export type {
  DetectionRunSummary,
  ObjectiveDetectionOutcome,
  ObjectiveReadiness,
} from './services/headline-detection.service';

// Auction report ingestion — bounded, single-UTC-day, idempotent.
export { AuctionReportIngestionService, BID_TOTAL_FIELDS, REJECTION_TOTAL_FIELDS, PING_TOTAL_FIELDS } from './services/auction-report-ingestion.service';
export type { AuctionIngestInput, AuctionIngestResult, EndpointOutcome } from './services/auction-report-ingestion.service';

// Auction reconciliation — pure comparison + classification.
export {
  reconcileGrain,
  reconcileTotals,
  DEFECT_CLASSIFICATIONS,
  BID_FIELD_PLAN,
  REJECTION_FIELD_PLAN,
  PING_FIELD_PLAN,
  NON_SUMMABLE_FOOTER_FIELDS,
} from './services/auction-reconciliation';
export type { DiffClassification, FieldDiff, GrainReconciliation, ReconcileGrainInput } from './services/auction-reconciliation';

export { CaseBriefService } from './services/case-brief.service';
export type { CaseBriefDeps, CaseHeadlineReader, CaseReader } from './services/case-brief.service';
export { CaseFindingService, FINDING_RECORD_OUTCOMES } from './services/case-finding.service';
export {
  CaseRecommendationService,
  RECOMMENDATION_RECORD_OUTCOMES,
} from './services/case-recommendation.service';
export { CaseEvidenceService, EVIDENCE_REPORT_OUTCOMES } from './services/case-evidence.service';
// CRM P0.2d: governed Party creation (identityResolution:create) and establishment
// (identityResolution:approve). Keys are minted, never derived from contact values.
export { PartyService, PARTY_WRITE_OUTCOMES, PARTY_ESTABLISHMENT_BASES } from './services/party.service';
// Identity match suggestions (D1): proposed by a detector, decided only here, by a person.
export {
  IdentitySuggestionService,
  IDENTITY_SUGGESTION_CONFIRMED_AUDIT_ACTION,
  IDENTITY_SUGGESTION_REJECTED_AUDIT_ACTION,
} from './services/identity-suggestion.service';
export type { IdentitySuggestionActor, IdentitySuggestionDecision, IdentitySuggestionServiceDeps } from './services/identity-suggestion.service';
export { PartyRecordService } from './services/party-record.service';
// The governed CRM Relationship and Participant authority (slices R3-A1, R3-A2).
// Every consequential write puts the row, its event, its audit entry and its outbox
// row in ONE transaction. See ./services/crm-relationship.service.ts.
export { CrmRelationshipService } from './services/crm-relationship.service';
export type { CrmRelationshipActor, CrmRelationshipServiceResult, CrmRelationshipServiceDeps } from './services/crm-relationship.service';
// Universal Activity reads, authorized (slice A2). Every source is read under its
// own guard; the service grants nothing. See ./services/activity.service.ts.
export { ActivityService } from './services/activity.service';
export type { ActivityViewer, ActivityReadResult, ActivityServiceDeps } from './services/activity.service';
// CRM P0.2e: governed Customer -> Party links (identityResolution:approve; target must be established).
export {
  CustomerPartyLinkService,
  CUSTOMER_PARTY_LINK_OUTCOMES,
  CUSTOMER_PARTY_LINK_BASES,
} from './services/customer-party-link.service';
export type {
  CustomerPartyLinkOutcome,
  CustomerPartyLinkResult,
  CustomerPartyLinkDeps,
  CustomerPartyLinkActOptions,
} from './services/customer-party-link.service';
export type { PartyWriteOutcome, PartyWriteResult, PartyEstablishmentBasis, PartyServiceDeps, PartyActOptions } from './services/party.service';
export type { PartyReadResult, PartyRecordServiceDeps } from './services/party-record.service';
export type {
  CaseEvidenceCaseAccess,
  CaseEvidenceDeps,
  EvidenceReportOutcome,
  ReportEvidenceInput,
  ReportEvidenceResult,
} from './services/case-evidence.service';
export { CaseParticipationService, PARTICIPATION_OUTCOMES } from './services/case-participation.service';
export type {
  AddCaseParticipantInput,
  CaseParticipationDeps,
  ParticipationCaseAccess,
  ParticipationHeadlineReader,
  ParticipationOutcome,
  ParticipationResult,
} from './services/case-participation.service';
export { CaseParticipantRepository } from './repositories/case-participant.repository';
// --- Work OS execution governance ---
export { WorkExecutionRepository, normalizeState, toEventRecords, stageIsClosed, TRANSITION_REFUSALS } from './repositories/work-execution.repository';
export type {
  StageWithInstance,
  TransitionInput,
  TransitionRefusal,
  TransitionResult,
  DependencyResult,
} from './repositories/work-execution.repository';
export { WorkExecutionService } from './services/work-execution.service';
export { WorkReactivationService, WORK_EVENT_NAMES } from './services/work-reactivation.service';
export { CaseWorkCoordinationService } from './services/case-work-coordination.service';
export { CaseMonitoringService, MONITORING_OUTCOMES } from './services/case-monitoring.service';
export { CaseLearningService } from './services/case-learning.service';
export { CaseWorkspaceService } from './services/case-workspace.service';
export type { CaseWorkspaceView, AttentionView, CaseWorkspaceDeps } from './services/case-workspace.service';
export type { CaseLearningDeps } from './services/case-learning.service';
export type { MonitoringView, CaseMonitoringDeps, MonitoringActOutcome } from './services/case-monitoring.service';
export type { CaseCoordinationDeps } from './services/case-work-coordination.service';
export type { ReactivationResult, WorkReactivationDeps } from './services/work-reactivation.service';
export type { WorkExecutionView, WorkExecutionDeps } from './services/work-execution.service';
export type { AddParticipantInput } from './repositories/case-participant.repository';
export { PersonalPriorityService } from './services/personal-priority.service';
export type {
  PersonalPriorityDeps,
  PersonalQueueView,
  PriorityCaseAccess,
  PriorityHeadlineReader,
  QueueOrdering,
} from './services/personal-priority.service';
export type {
  CaseRecommendationDeps,
  CaseRecommendationsView,
  RecommendationCaseAccess,
  RecommendationFindingReader,
  RecommendationOptionView,
  RecommendationRecordOutcome,
  RecommendationRevisionView,
  RecordRecommendationsInput,
  RecordRecommendationsResult,
} from './services/case-recommendation.service';
export type {
  CaseFindingCaseAccess,
  CaseFindingDeps,
  CaseFindingHeadlineReader,
  CaseFindingReadinessReader,
  FindingRecordOutcome,
  RecordFindingInput,
  RecordFindingResult,
} from './services/case-finding.service';
export { HeadlineInvestigationService } from './services/headline-investigation.service';
export type {
  HeadlineInvestigationDeps,
  HeadlineReader,
  InvestigationFinder,
  InvestigationOpener,
  PromoteHeadlineInput,
  PromotionResult,
} from './services/headline-investigation.service';
export { IngestionService, isDuplicateObservation } from './services/ingestion.service';
export type { IngestInput, IngestResult } from './services/ingestion.service';
export { deriveSignals, SIGNAL_REGISTRY } from './services/signal-registry';
export type { SignalDefinition, DerivedSignal } from './services/signal-registry';
export { NextBestActionService } from './services/next-best-action.service';
export type {
    NextBestAction,
    NextBestActionKind,
    NextBestActionContext,
    NextBestActionResult,
} from './services/next-best-action.service';

// Sprint 17 - CallGrid API reconciliation / backfill service.
export {
  ProviderObservationService,
  CALLGRID_PROVIDER,
  CALLS_STREAM,
  PROVIDER_QUERY_SOURCE,
  CERTIFICATION_PAGE_CAP,
} from './services/provider-observation.service';
export type { CertifyDayInput } from './services/provider-observation.service';
export {
  ProviderReconciliationService,
  RECONCILIATION_PAGE_CAP,
  LOCAL_SCAN_MARGIN_MS,
  LOCAL_SCAN_BATCH_SIZE,
  RECONCILIATION_DIMENSION,
  MEMBER_ID_FIELD,
  MEMBER_LABEL_FIELDS,
  memberIdFrom,
  memberLabelFrom,
  callGridPopulationReader,
  integrationEventReader,
} from './services/provider-reconciliation.service';
export type {
  ReconcileDayInput,
  ReconcileDayResult,
  ProviderPopulation,
  ProviderPopulationReader,
  ProviderPopulationRecord,
  LocalDeliveryReader,
  LocalDeliveryRecord,
} from './services/provider-reconciliation.service';
// The ONE write-capable CallGrid REST path. `CallGridReconciliationService` stood
// here until PR 9 and was a second one: it ingested whatever it had fetched
// before knowing the interval was complete, and routed already-PROCESSED rows
// into a direct metadata merge that never reached IngestionService.
export {
  CallGridPollService,
  CALLGRID_POLL_OUTCOMES,
  CALLGRID_POLL_PROVIDER,
  CALLGRID_POLL_STREAM,
  POLL_OBSERVATION_SOURCE,
  POLL_PROGRESS_EVERY,
  RECOVERY_OBSERVATION_SOURCE,
  callGridIntervalReader,
  identityDigest,
  mapCallGridEventType,
  checkpointMayAdvance,
  pollSucceeded,
  sinceForRange,
} from './services/callgrid-poll.service';
export type {
  CallGridIngestor,
  CallGridIntervalReader,
  CallGridPollDeps,
  CallGridPollInput,
  CallGridPollExecution,
  CallGridPollObserver,
  CallGridPollOutcome,
  PollRefusal,
  SyncRange,
} from './services/callgrid-poll.service';
export { IntegrationOsService } from './services/integration-os.service';
export type {
  ProviderStatus,
  ProviderStatusInput,
  ConnectionState,
  HealthState,
  SecretStatus,
  EventRow,
  ApiSyncInfo,
} from './services/integration-os.service';

// Sprint 27C — Business Process Engine · PR A (canonical contracts + guard policy).
// Provider-neutral domain contracts and pure, deterministic transition guards.
// No persistence, repositories, definitions, or wiring in this PR (those are B/C/D).
export * from './process-engine';

// Work OS — Work Type catalog/vocabularies + the pure Start Work submission builder.
export * from './work-os/work-type-catalog';
export * from './work-os/start-work';
// Configurable sequential workflow — assignment resolution, dedup, fields, steps.
export * from './work-os/workflow';

export const repositories: Repositories = createRepositories(prisma);

/**
 * The Decision Engine, over the shared client.
 *
 * THE producer-facing surface for operational decisions. A producer uses this and
 * never `repositories.operationalPriorities` — reaching past it skips the
 * transaction boundary, the projection rewrite and the outbox publication in one
 * go, and each of those failures is silent.
 */
export const decisionEngine = createDecisionEngine(prisma);

export * from '@prisma/client';
export default prisma;

// CallGrid live reconciliation harness (pure; runs against any record source).
export {
  reconcile,
  formatReconcileReport,
} from './services/callgrid-reconciliation.harness';
export { callGridSourceCallFromRecord, CALLGRID_SOURCE_FIELDS } from './services/callgrid-reconciliation-source';
export type {
  CallGridSourceCall,
  LoopCall,
  ReconcileReport,
  ReconcileOptions,
  FieldCheck,
} from './services/callgrid-reconciliation.harness';

export {
  ProviderPollCheckpointRepository,
  type AdvanceOutcome,
  type AdvanceResult,
  type PollCheckpointView,
} from './repositories/provider-poll-checkpoint.repository';
export {
  CallGridRoutinePollService,
  CALLGRID_POLL_POLICY,
  type CallGridRoutinePollDeps,
  type RoutinePollInput,
  type RoutinePollResult,
} from './services/callgrid-routine-poll.service';

export {
  ProviderFactRevisionRepository,
  renderFactValue,
  type FactRevisionView,
  type RecordFactRevisionInput,
} from './repositories/provider-fact-revision.repository';

// The Loop AI runtime gateway (slice B5, AI S1 preparation). It invokes whatever
// providers are registered with it; the only implementation that exists replays
// recorded fixtures. No SDK, no credential, and `activated` defaults to false.
// See ./services/ai-runtime/gateway.ts.
export { AiRuntimeGateway, InMemoryAiUsageLedger, AI_CALL_OUTCOMES } from './services/ai-runtime/gateway';
export type {
  AiProviderPort,
  AiUsageLedger,
  AiRuntimeConfig,
  AiRuntimeDeps,
  AiRunRequest,
  AiRunResult,
  AiPrincipal,
  AiAuthorizer,
  AiCallReservation,
  AiCallReconciliation,
  AiReserveResult,
} from './services/ai-runtime/gateway';
// Who may invoke an AI task: an active human member, in a listed role, holding every
// required permission through the enforcing can(). Never AI_EMPLOYEE.
export { iamAiAuthorizer, AI_INVOKER_FORBIDDEN_ROLES } from './services/ai-runtime/authorizer';
// Case Explanation: the first AI task. Read-only, on demand, citation-bound; it
// authorizes before reading and sends structured facts only.
export { CaseExplanationService } from './services/ai-runtime/case-explanation.service';
export type {
  CaseExplanationResult,
  CaseExplanationProvenance,
  CaseExplanationRuntime,
  CaseExplanationDeps,
} from './services/ai-runtime/case-explanation.service';
export {
  buildCaseExplanationContext,
  CASE_CONTEXT_MAX_EVIDENCE,
  CASE_CONTEXT_WITHHELD,
} from './services/ai-runtime/case-explanation-context';
export type {
  CaseExplanationContext,
  CaseExplanationSource,
  CaseContextManifestEntry,
  CaseContextWithheld,
} from './services/ai-runtime/case-explanation-context';
export {
  CASE_EXPLANATION_SCHEMA,
  CASE_EXPLANATION_SCHEMA_ID,
  CASE_EXPLANATION_TEMPLATE_ID,
  CASE_EXPLANATION_TEMPLATE_VERSION,
  renderCaseExplanationInstructions,
} from './services/ai-runtime/templates/case-explanation';

// Authorized Relationship reads (slice R3-A3). Separate from the write service, as
// PartyRecordService is from PartyService. Capabilities come back with the data.
// See ./services/crm-relationship-read.service.ts.
export { CrmRelationshipReadService } from './services/crm-relationship-read.service';
export type { CrmRelationshipViewer, CrmRelationshipReadResult, CrmRelationshipReadServiceDeps } from './services/crm-relationship-read.service';
export { CrmRelationshipReadModelRepository, CrmRelationshipCursorError } from './repositories/crm-relationship-read-model.repository';
export type { CrmRelationshipListOptions, CrmRelationshipReadModelDeps } from './repositories/crm-relationship-read-model.repository';

// --- The durable AI usage ledger ---
// The table an organization's daily AI budget is actually safe on. An interface
// backed by one instance's memory cannot cap spend on serverless, where instances
// share no memory. Reserve before the call, reconcile after it. Raw provider usage
// plus the price-list version to value it with, so historical cost stays
// reproducible; no prompt and no response, ever. See
// ./repositories/ai-usage-ledger.repository.ts and docs/architecture/ai-usage-ledger.md.
export {
  AiUsageLedgerRepository,
  aiContextManifestHash,
  aiBudgetDateAsUtcDate,
  AI_INVOCATION_IN_FLIGHT,
} from './repositories/ai-usage-ledger.repository';
export type {
  AiInvocationReserveInput,
  AiInvocationReconcileInput,
  AiLedgerDb,
} from './repositories/ai-usage-ledger.repository';
export { DurableAiUsageLedger, isSerializationFailure } from './services/ai-usage-ledger.service';
export type { DurableAiUsageLedgerDeps } from './services/ai-usage-ledger.service';

// --- Brain durable execution (B4) ---
// Neon as the only authority for Brain work: jobs and their history, steps and sealed
// checkpoints, questions and their one reply, commands, events, and stored AI controls.
// Nothing in the product calls these yet (B5), and none of it chooses a provider or a
// model. See docs/architecture/brain-persistence.md.
export { BrainJobRepository, BRAIN_ACCEPT_REFUSALS } from './repositories/brain/brain-job.repository';
export type {
  BrainJobAcceptance,
  BrainAcceptOutcome,
  BrainAcceptRefusal,
  BrainJobRecord,
  BrainTransitionRecord,
  BrainLeaseOutcome,
  BrainCancelOutcome,
} from './repositories/brain/brain-job.repository';
export { BrainWaitRepository } from './repositories/brain/brain-wait.repository';
export type {
  BrainWaitQuestion,
  BrainWaitOpenOutcome,
  BrainWaitAnswerOutcome,
  BrainWaitExpireOutcome,
  BrainWaitResumeOutcome,
  BrainWaitView,
} from './repositories/brain/brain-wait.repository';
export { BrainStepRepository } from './repositories/brain/brain-step.repository';
export type {
  BrainCheckpointRef,
  BrainStepResumeState,
  BrainStepBeginOutcome,
  BrainCheckpointOutcome,
  BrainStepSummary,
} from './repositories/brain/brain-step.repository';
export { BrainCommandRepository, BrainEventRepository } from './repositories/brain/brain-command.repository';
export type { BrainCommandRecord, BrainEventRecord } from './repositories/brain/brain-command.repository';
export { BrainExecutionReferences } from './repositories/brain/brain-execution-references';
export type { BrainJobReference, BrainCommandReference, BrainWaitReference } from './repositories/brain/brain-execution-references';
export { AiControlRepository } from './repositories/brain/ai-control.repository';
export type { AiControlRecordOutcome, AiControlChange } from './repositories/brain/ai-control.repository';
export {
  BrainRecordUnreadable,
  BrainPersistenceInvariantError,
  brainSealedPayloadRefusals,
  BRAIN_SEALED_PAYLOAD_REFUSALS,
  BRAIN_CHECKPOINT_MAX_BYTES,
} from './repositories/brain/brain-records';
export type {
  BrainSealedPayload,
  BrainPayloadSealer,
  BrainPayloadSealingContext,
  BrainSealedPayloadRefusal,
  BrainTaskInput,
} from './repositories/brain/brain-records';
export type { BrainTransitionOutcome, BrainWriteRefusal } from './repositories/brain/brain-job-writes';
// Composed into the live Activity feed in B5, after migration 36 was deployed.
export { BrainEventActivityAdapter, brainEventTitle } from './repositories/activity/brain-event.adapter';

// --- The Loop-side Brain boundary (B5) ---
// What a signed-in person reaches (submit, status, answer, cancel), what an executor may
// do to Loop's records, and the three questions an executor may ask Loop. Nothing here
// calls a model, a provider or an execution environment. See
// docs/architecture/brain-boundary.md.
export {
  BrainWorkService,
  BRAIN_SUBMIT_REFUSALS,
  BRAIN_WORK_PHASES,
  brainWorkPhase,
  brainWorkViewOf,
} from './services/brain/brain-work.service';
export type {
  BrainWorkPrincipal,
  BrainWorkDeps,
  BrainWorkView,
  BrainWorkPhase,
  BrainResultLocation,
  BrainSubmitOutcome,
  BrainSubmitRefusal,
  BrainQuestionView,
  BrainRespondOutcome,
  BrainCancelWorkOutcome,
  BrainSubjectWorkItem,
  BrainDoorbellOutcome,
} from './services/brain/brain-work.service';
export { BrainExecutorStore } from './services/brain/brain-executor-store';
export type { BrainExecutorJob, BrainClaimOutcome, BrainCommandLookup, BrainExecutorTransition } from './services/brain/brain-executor-store';
export { BrainInternalService, defaultBrainContextAssemblers } from './services/brain/brain-internal.service';
export { AesGcmBrainPayloadSealer, BrainPayloadUnopenable, BRAIN_SEAL_VERSION_AES_GCM } from './services/brain/brain-payload-sealer';
export type {
  BrainInternalDeps,
  BrainTaskContext,
  BrainContextAssembler,
  BrainResultOwnerGate,
  BrainAccessAnswer,
  BrainContextAnswer,
  BrainCommitGateState,
  BrainCommitAnswer,
} from './services/brain/brain-internal.service';
export { PrismaBrainSubjectResolver, brainSubjectHref, BRAIN_BUILT_SUBJECT_TYPES } from './services/brain/brain-subjects';
export type { BrainSubject, BrainSubjectResolver } from './services/brain/brain-subjects';

// --- Google Workspace connection (Private V1) ---
// One Google connection per Loop user per organization (Gmail metadata, Calendar events
// read-only, Drive metadata), granted one capability at a time. The repository stores
// sealed bytes only; the service runs the lifecycle with Google, the sealer and the IAM
// decision injected. See docs/architecture/google-workspace-connection.md §11.
export {
  GoogleConnectionRepository,
  revokeGoogleConnectionInTx,
  GOOGLE_OAUTH_STATE_LIFETIME_MS,
  GOOGLE_OAUTH_MAX_OPEN_STATES,
} from './repositories/google-connection.repository';
export type {
  GoogleActor,
  GoogleConnectionRecord,
  GoogleConnectionInventoryRow,
  ConsumedGoogleOAuthState,
  GoogleGrantToStore,
  GoogleStoreOutcome,
  GoogleRevocation,
} from './repositories/google-connection.repository';
export { GoogleWorkspaceService, sha256Hex as googleStateHash } from './services/google/google-workspace.service';
export type {
  GooglePrincipal,
  GoogleSessionPrincipal,
  GoogleOAuthPort,
  GoogleAuthority,
  GoogleWorkspaceServiceDeps,
  GoogleWorkspaceStatus,
  GoogleBeginResult,
  GoogleCallbackQuery,
  GoogleCallbackResult,
  GoogleAccessTokenResult,
} from './services/google/google-workspace.service';
export {
  GoogleTokenSealer,
  GoogleTokenUnopenable,
  googleTokenKeyRef,
  GOOGLE_TOKEN_SEAL_VERSION,
  GOOGLE_TOKEN_PURPOSE,
} from './services/google/google-token-sealer';
export type { GoogleTokenBinding, SealedGoogleToken } from './services/google/google-token-sealer';

// Daily Loop calendar ingestion (DL-3): one employee's calendar, into their own work state.
// The Google connection, the sensor and the clock are injected; the principal is the whole
// authorization.
export {
  CalendarSyncService,
  eventFactsFor,
  CALENDAR_LOOKBACK_DAYS,
  CALENDAR_LOOKAHEAD_DAYS,
} from './services/work-state';
export type {
  CalendarAccessPort,
  CalendarSensorPort,
  CalendarSyncDeps,
  CalendarSyncMode,
  CalendarSyncOptions,
  CalendarSyncOutcome,
  CalendarConnectionState,
} from './services/work-state';
// The Calendar sync as a runtime assembles it (DL-5). One assembly, so the scheduled cycle and
// the web server read a calendar the same way, with the same hardened network and the same IAM.
export {
  createEmployeeCalendarSync,
  calendarAccessPort,
  calendarGoogleWorkspace,
  employeeGoogleAccessPort,
  employeeGoogleWorkspace,
  googleCalendarSensor,
  type EmployeeCalendarSyncConfig,
} from './services/work-state';
// Gmail ingestion (GM-1).
export {
  GmailSyncService,
  GMAIL_INITIAL_DAYS,
  type GmailAccessPort,
  type GmailSensorPort,
  type GmailSyncDeps,
  type GmailSyncMode,
  type GmailSyncOptions,
  type GmailSyncOutcome,
} from './services/work-state';
export { WorkDraftRepository, type DraftContent, type SendAttempt } from './repositories/work-state';
export { createGoogleOAuthPort, googleFetch } from './services/google/google-oauth-port';
export type { GoogleClientConfig, GoogleFetch } from './services/google/google-oauth-port';

// The Gmail sync as a runtime assembles it (GM-1): one assembly for the visit refresh, the
// manual refresh and the scheduled cycle, plus the two on-demand reads that are never stored.
export {
  createEmployeeGmailSync,
  googleGmailSensor,
  gmailAccessPort,
  readEmployeeGmailThread,
  sendEmployeeGmailMessage,
  lookupEmployeeGmailSent,
  employeeGmailIdentity,
  type EmployeeGmailConfig,
} from './services/work-state';

// Sending one employee's reply, as themselves (GM-2). The only path out of Loop into somebody
// else's inbox, and the only place its rules live.
export { MailSendService, type MailSendDeps, type MailSendPort, type MailSendOutcome } from './services/work-state';

// Draft with Loop (GM-3): a proposed reply, in the employee's own composer. It has no send port
// and no path to one -- sending is a separate act, by a person, under its own authority.
export { MailReplyDraftService, type MailReplyDraftDeps, type MailReplyDraftResult, type MailThreadReader } from './services/ai-runtime/mail-reply-draft.service';
export { buildMailReplyContext, MAIL_DRAFT_CONTEXT_LIMITS } from './services/ai-runtime/mail-reply-context';
export {
  MAIL_REPLY_DRAFT_SCHEMA,
  MAIL_REPLY_DRAFT_SCHEMA_ID,
  MAIL_REPLY_DRAFT_TEMPLATE_ID,
  MAIL_REPLY_DRAFT_TEMPLATE_VERSION,
  renderMailReplyDraftInstructions,
} from './services/ai-runtime/templates/mail-reply-draft';

// A mailbox's state as the employee's own work items (GM-3). A detection never overrules a person:
// a closed item reopens only on new evidence, and a correction is recorded beside the facts.
export { MailAttentionService, mailThreadFacts, type MailAttentionDeps, type MailAttentionOutcome } from './services/work-state';
export * from './services/intelligence';

// Provider connection secret sealing (Teams OAuth token / Telegram MTProto session).
export {
  ConnectionSecretSealer,
  ConnectionSecretUnopenable,
  connectionSecretKeyRef,
  CONNECTION_SECRET_SEAL_VERSION,
  CONNECTION_SECRET_PURPOSE,
} from './services/connections/connection-secret-sealer';
export type { ConnectionSecretBinding, SealedConnectionSecret } from './services/connections/connection-secret-sealer';

// Provider-neutral connection adapter + worker runtime (Teams/Telegram and future sources).
export type { ConnectionAdapter, AdapterSession, ObservationResult } from './services/connections/connection-adapter';
export { runConnectionCycle } from './services/connections/connection-runtime';
export type { ConnectionCycleInput, ConnectionCycleResult, CycleFailure } from './services/connections/connection-runtime';
// Background conversation source connections (Teams, Telegram): persistence. The Teams/Telegram
// sibling of GoogleConnectionRepository -- org-first, user-private, sealed bytes only. Instantiated
// on demand (like Google), not registered in the repositories bag.
export {
  SourceConnectionRepository,
  disconnectSourceConnectionsInTx,
  knownConnectionProviders,
} from './repositories/source-connection.repository';
export type {
  SourceConnectionActor,
  SourceConnectionRecord,
  SourceConnectionCredentialToStore,
  SourceConnectionStoreOutcome,
  DueConnection,
} from './repositories/source-connection.repository';
export { SourceConnectionService } from './services/connections/source-connection.service';
export type {
  SourceConnectionPrincipal,
  SourceConnectionAuthority,
  SourceConnectionServiceDeps,
  SourceConnectionStatus,
  ProviderConnectionView,
} from './services/connections/source-connection.service';
