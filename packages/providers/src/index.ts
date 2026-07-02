// @emgloop/providers — Sprint 1 + Sprint 3 + Sprint 10 + Sprint 11 + Sprint 14.
//
// Provider abstraction package barrel. Sprint 11 added the first real ingestion
// adapter (CallGrid). Sprint 14 adds the second (WebsiteProvider). Concrete
// adapters do not auto-register at import time; the host wires them into the
// registry on first use via the helpers below, so consumers resolve providers
// through the registry rather than constructing adapters directly.

export * from './types';
export * from './registry';
export {
  verifySignedWebhook,
  computeSignature,
  parseTimestamp,
  verifyCallGridAuth,
  timingSafeTokenEqual,
} from './webhook-security';
export type {
  WebhookSecurityResult,
  WebhookSecurityOptions,
  CallGridAuthOptions,
  AuthMethod,
} from './webhook-security';
export {
  verifyPropertyIngest,
  normalizeHost,
  hostMatchesDomains,
} from './property-ingest';
export type {
  PropertyIngestIdentity,
  PropertyIngestInput,
  PropertyIngestResult,
} from './property-ingest';
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
// Sprint 14 — Website Intelligence (WebsiteProvider).
import { WebsiteProvider } from './adapters/website.provider';
import { registerProvider, getProvider, hasProvider } from './registry';
import type { IngestionProvider } from './interfaces/ingestion.provider';

export { CallGridProvider, mapCallgridEventType, CALLGRID_EVENT_MAP } from './adapters/callgrid.provider';
// Sprint 17 - CallGrid REST API reconciliation/backfill client.
export {
  fetchCallGridCallsPage,
  fetchAllCallGridCalls,
  mapCallGridApiRecord,
  resolveCallGridBaseUrl,
  parseDurationSeconds,
  pickField,
  toNumber,
  toBool,
  CallGridApiError,
  CALLGRID_API_DEFAULT_BASE_URL,
  CALLGRID_CALLS_PATH,
} from './adapters/callgrid-api';
export type { CallGridApiFetchOptions, CallGridApiPage } from './adapters/callgrid-api';
export {
  WebsiteProvider,
  mapWebsiteEventType,
  WEBSITE_EVENT_MAP,
  WEBSITE_PROPERTIES,
} from './adapters/website.provider';
export type { WebsiteProperty } from './adapters/website.provider';

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

/**
 * Register the Website adapter into the provider registry (idempotent). Sprint
 * 14 — gives the Brain its second sense (websites) through the same registry.
 */
export function registerWebsite(): void {
  if (!hasProvider('ingestion', 'website')) {
    registerProvider(new WebsiteProvider());
  }
}

/**
 * Resolve the Website adapter through the provider registry, registering it on
 * first use. The website webhook route uses this instead of constructing
 * WebsiteProvider directly, so all resolution flows through the Provider Layer.
 */
export function getWebsiteProvider(): IngestionProvider {
  registerWebsite();
  return getProvider<IngestionProvider>('ingestion', 'website');
}

export type {
  Sensor,
  ObserveWindow,
  ObserveResult,
} from './interfaces/sensor.provider';
