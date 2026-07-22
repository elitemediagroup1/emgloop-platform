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

export { IngestionService } from './services/ingestion.service';
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
export { CallGridReconciliationService, sinceForRange, mapReconEventType } from './services/callgrid-reconciliation.service';
export type { ReconciliationInput, ReconciliationResult, SyncRange } from './services/callgrid-reconciliation.service';
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

export * from '@prisma/client';
export default prisma;

// CallGrid live reconciliation harness (pure; runs against any record source).
export {
  reconcile,
  formatReconcileReport,
} from './services/callgrid-reconciliation.harness';
export type {
  CallGridSourceCall,
  LoopCall,
  ReconcileReport,
  ReconcileOptions,
  FieldCheck,
} from './services/callgrid-reconciliation.harness';
