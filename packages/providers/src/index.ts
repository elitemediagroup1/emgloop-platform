// @emgloop/providers — Sprint 1 + Sprint 3 + Sprint 10 + Sprint 11.
//
// Provider abstraction package barrel. Sprint 11 adds the first real ingestion
// adapter: CallGrid. No concrete provider auto-registers here; the host wires
// adapters into the registry at runtime via registerProvider().

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
export { CallGridProvider, mapCallgridEventType, CALLGRID_EVENT_MAP } from './adapters/callgrid.provider';
