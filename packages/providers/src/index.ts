// @emgloop/providers — Sprint 1 + Sprint 3 + Sprint 10 (Loop Intelligence Foundation).
//
// Provider abstraction package barrel. Sprint 10 adds ingestion and analytics
// provider interfaces and mock adapters. No concrete provider adapters are
// registered here — those arrive when real integrations are built.


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
