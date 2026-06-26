// MockAnalyticsProvider — Sprint 10 (Loop Intelligence Foundation).
//
// No-op mock adapter for analytics providers.
// Returns empty/zero results. Real adapters (GA4, Google Ads, GSC) slot in
// without changing any consumer code.


import type { ProviderContext } from '../types';
import type {
  AnalyticsProvider,
  AnalyticsCapabilities,
  AnalyticsQuery,
  AnalyticsResult,
} from '../interfaces/analytics.provider';


export class MockAnalyticsProvider implements AnalyticsProvider {
  readonly info = {
    id: 'mock-analytics',
    category: 'analytics' as const,
    displayName: 'Mock Analytics Provider',
  };

  async healthCheck(_ctx: ProviderContext) {
    return { ok: true, checkedAt: new Date().toISOString() };
  }

  capabilities(): AnalyticsCapabilities {
    return {
      availableMetrics: ['sessions', 'clicks', 'impressions', 'conversions'],
      availableDimensions: ['date', 'channel', 'source'],
      realtime: false,
    };
  }

  async query(
    _ctx: ProviderContext,
    query: AnalyticsQuery,
  ): Promise<AnalyticsResult> {
    return {
      rows: [],
      totals: query.metrics.map((m) => ({ name: m, value: 0 })),
      rowCount: 0,
      sampledData: false,
    };
  }
}
