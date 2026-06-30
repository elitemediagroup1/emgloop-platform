// @emgloop/database
//
// Single source of the Prisma client for the whole platform.
// A singleton avoids exhausting Postgres connections in dev / serverless.

import { PrismaClient } from '@prisma/client';
import { createRepositories, type Repositories } from './repositories';

declare global {
    // eslint-disable-next-line no-var
  var __emgloopPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
    global.__emgloopPrisma ??
    new PrismaClient({
          log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
    });

if (process.env.NODE_ENV !== 'production') {
    global.__emgloopPrisma = prisma;
}

export * from './repositories';
export * from './integration-catalog';

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
} from './services/integration-os.service';

export const repositories: Repositories = createRepositories(prisma);

export * from '@prisma/client';
export default prisma;
