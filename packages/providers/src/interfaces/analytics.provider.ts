// AnalyticsProvider — Sprint 10 (Loop Intelligence Foundation).
//
// Provider-agnostic interface for analytics / marketing intelligence sources.
// Google Analytics 4, Google Ads, Google Search Console, Microsoft Clarity
// all implement this interface. No vendor SDK is imported here.


import type { BaseProvider, ProviderContext } from '../types';


// ---- Metric shape ---------------------------------------------------------

export interface AnalyticsMetric {
  name: string;
  value: number;
  unit?: string;   // e.g. "clicks", "sessions", "USD"
}

export interface AnalyticsDimension {
  name: string;
  value: string;
}

export interface AnalyticsRow {
  dimensions: AnalyticsDimension[];
  metrics: AnalyticsMetric[];
  date?: string;   // ISO date if the query is time-series
}

// ---- Query shape ----------------------------------------------------------

export interface AnalyticsQuery {
  /** ISO start date (inclusive). */
  startDate: string;
  /** ISO end date (inclusive). */
  endDate: string;
  metrics: string[];
  dimensions?: string[];
  filters?: Record<string, string>;
  limit?: number;
}

export interface AnalyticsResult {
  rows: AnalyticsRow[];
  totals?: AnalyticsMetric[];
  rowCount: number;
  sampledData?: boolean;
}

// ---- Provider capabilities ------------------------------------------------

export interface AnalyticsCapabilities {
  /** Metric names this provider supports. */
  availableMetrics: readonly string[];
  /** Dimension names this provider supports. */
  availableDimensions: readonly string[];
  /** Earliest date available for historical queries. */
  earliestDate?: string;
  /** Whether the provider supports real-time data. */
  realtime: boolean;
}

// ---- Provider interface ---------------------------------------------------

export interface AnalyticsProvider extends BaseProvider {
  readonly info: BaseProvider['info'] & { category: 'analytics' };

  /** Describe this provider's query capabilities. */
  capabilities(): AnalyticsCapabilities;

  /**
   * Run an analytics query and return the results.
   * This is a read-only operation — no data is written to the external system.
   * No real API call until a concrete adapter is registered.
   */
  query(ctx: ProviderContext, query: AnalyticsQuery): Promise<AnalyticsResult>;
}
