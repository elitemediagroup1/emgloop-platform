// AnalyticsProvider -- the provider-agnostic contract for an EXTERNAL website analytics source (2026-09-30).
//
// Google Analytics 4, Google Search Console, Bing Webmaster Tools and Microsoft Clarity will each implement this
// against their own read API; NONE is implemented today, and no class in this repository implements it. There is
// no vendor SDK here and no network call. (Google Ads is not a Loop source and never implements this.)
//
// WHAT A RESULT MUST SAY, because the Brain must not be told more than the source knew:
//   - NULL IS NOT ZERO. A metric the source did not report is `null`; a reported zero is 0. An adapter never fills
//     a gap, and a row the source omitted is not a row of zeros.
//   - FINALITY. A window the source may still revise (GA4 for days; Search Console for ~2 days) is PRELIMINARY.
//   - COMPLETENESS. A result cut short by a row cap, missing pagination or a partial page is PARTIAL, never COMPLETE.
//   - QUALITY. Sampling, thresholding, "(other)" roll-up, truncation, the empty reason and the reporting time zone
//     are carried exactly as the source stated them (null where it did not say).
//   - IDENTITY. `sourceId` names the governed system (the source registry); `stream` names the real-world events it
//     observes, which is what independence is counted over. They are different facts and both are kept.
//
// The contract rows are then stored as `source_metric_windows` (@emgloop/shared websiteSourceWindowProblems
// holds the stored shape: no search query text, no campaign names, no raw provider response).

import type {
  EvidenceCompleteness,
  IntelligenceEvidenceStream,
  SourceMetricValue,
  SourceWindowFinality,
  SourceWindowQuality,
} from '@emgloop/shared';
import type { BaseProvider, ProviderContext } from '../types';

// ---- Metric shape ---------------------------------------------------------

export interface AnalyticsMetric {
  name: string;
  /** NULL when the source did not report this metric for this row. Never 0-for-unknown. */
  value: SourceMetricValue;
  unit?: string;
}

export interface AnalyticsDimension {
  name: string;
  value: string;
}

export interface AnalyticsRow {
  dimensions: AnalyticsDimension[];
  metrics: AnalyticsMetric[];
  /** ISO date when the query is a daily series. */
  date?: string;
}

// ---- Query shape ----------------------------------------------------------

export interface AnalyticsQuery {
  /** ISO start date (inclusive), in the source's reporting time zone. */
  startDate: string;
  /** ISO end date (inclusive), in the source's reporting time zone. */
  endDate: string;
  metrics: string[];
  dimensions?: string[];
  limit?: number;
}

export interface AnalyticsResult {
  /** The governed source that answered (INTELLIGENCE_SOURCE_REGISTRY). */
  sourceId: string;
  /** The real-world stream that source observes (the registry's `stream`). */
  stream: IntelligenceEvidenceStream;
  rows: AnalyticsRow[];
  /** Totals the SOURCE reported. Absent when it reported none -- never summed or zero-filled by the adapter. */
  totals?: AnalyticsMetric[];
  /** Rows the source says exist, which may exceed `rows.length` (then completeness is PARTIAL). Null when unstated. */
  rowCount: number | null;
  finality: SourceWindowFinality;
  completeness: EvidenceCompleteness;
  quality: SourceWindowQuality;
}

// ---- Provider capabilities ------------------------------------------------

export interface AnalyticsCapabilities {
  availableMetrics: readonly string[];
  availableDimensions: readonly string[];
  /** Earliest date available for historical queries. */
  earliestDate?: string;
  /** How many days a window stays PRELIMINARY before the source treats it as settled. */
  preliminaryDays: number;
  realtime: boolean;
}

// ---- Provider interface ---------------------------------------------------

export interface AnalyticsProvider extends BaseProvider {
  readonly info: BaseProvider['info'] & { category: 'analytics' };

  capabilities(): AnalyticsCapabilities;

  /** A read-only query. Nothing is written to the external system. */
  query(ctx: ProviderContext, query: AnalyticsQuery): Promise<AnalyticsResult>;
}
