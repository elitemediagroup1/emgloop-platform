// @emgloop/providers — Sprint 1 + Sprint 3 + Sprint 10 + Sprint 11.
//
// Provider abstraction package barrel. Sprint 11 adds the first real ingestion
// adapter: CallGrid. Concrete adapters do not auto-register at import time; the
// host wires them into the registry on first use via the helpers below, so
// consumers resolve providers through the registry rather than constructing
// adapters directly.

export * from './types';
export * from './registry';
export type {
  IngestionProvider,
  IngestionCapabilities,
  InboundEvent,
  PollOptions,
  PollResult,
  WebhookVerificationResult,
} from './interfaces/ingestion.provider';
export type {
  AnalyticsProvider,
  AnalyticsCapabilities,
  AnalyticsQuery,
  AnalyticsResult,
  AnalyticsRow,
  AnalyticsMetric,
  AnalyticsDimension,
} from './interfaces/analytics.provider';
export { MockIngestionProvider } from './mocks/ingestion.mock';
export { MockAnalyticsProvider } from './mocks/analytics.mock';

// Sprint 11 — First Live Integration (CallGrid).
import { CallGridProvider } from './adapters/callgrid.provider';
import { registerProvider, getProvider, hasProvider } from './registry';
import type { IngestionProvider } from './interfaces/ingestion.provider';

export { CallGridProvider, mapCallgridEventType, CALLGRID_EVENT_MAP } from './adapters/callgrid.provider';

/**
 * Register the CallGrid adapter into the provider registry (idempotent). Call
 * this during host bootstrap so the adapter is resolvable via getProvider().
 */
export function registerCallGrid(): void {
  if (!hasProvider('ingestion', 'callgrid')) {
    registerProvider(new CallGridProvider());
  }
}

/**
 * Resolve the CallGrid adapter through the provider registry, registering it on
 * first use. Consumers (e.g. the webhook route) should use this instead of
 * constructing CallGridProvider directly, so all provider resolution flows
 * through the registry / Provider Layer.
 */
export function getCallGridProvider(): IngestionProvider {
  registerCallGrid();
  return getProvider<IngestionProvider>('ingestion', 'callgrid');
}
