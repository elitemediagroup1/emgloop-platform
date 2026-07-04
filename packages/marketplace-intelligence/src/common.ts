// @emgloop/marketplace-intelligence — shared domain primitives.
//
// PR #43 (Marketplace Intelligence Canonical Domain Model). This package
// establishes the PERMANENT, sensor-agnostic business abstraction that every
// future consumer (Admin Dashboard, Executive Dashboard, Daily Briefing, Brain
// Activity, Brain Briefing, Notifications, Workspace, Marketplace Intelligence
// pages, AI Employees, future Creator Intelligence, future Enterprise portals)
// will read from. It is additive, contracts-only: no runtime wiring, no UI, no
// database, no API endpoints, no schema changes, no LLM, no persistence.
//
// Philosophy: CallGrid (or Ringba, Invoca, Twilio, Salesforce, HubSpot, Meta,
// Google Ads, TikTok, or any future internal bidding system) is a SENSOR, never
// the product. This model must never expose sensor-specific thinking — it
// expresses business intelligence in EMG's own vocabulary, so that swapping or
// adding a sensor never requires redesigning the model. Sensors change;
// Marketplace Intelligence does not.
//
// Reuse over redeclaration: every Brain contract already established elsewhere
// (Confidence, RecommendationEnvelope) is imported from @emgloop/brain, never
// duplicated here.

import type { Metadata, TenantScope } from '@emgloop/shared';
import type { Confidence, RecommendationEnvelope } from '@emgloop/brain';

// ---------------------------------------------------------------------------
// Sensors — open-ended, never a closed union.
// ---------------------------------------------------------------------------

/** Non-exhaustive catalog of sensors known today. This list is advisory only
 * (naming/autocomplete convenience); MarketplaceSensorId stays an open string so
 * a brand-new sensor never requires a type change here. */
export const KNOWN_MARKETPLACE_SENSORS = [
  'callgrid',
  'ringba',
  'invoca',
  'twilio',
  'salesforce',
  'hubspot',
  'meta',
  'google_ads',
  'tiktok',
  'internal',
] as const;

export type KnownMarketplaceSensor = (typeof KNOWN_MARKETPLACE_SENSORS)[number];

/** The identifier of whichever sensor(s) fed a piece of Marketplace
 * Intelligence. Open string so it is future-proof: today CallGrid, tomorrow
 * anything else, without redesigning the model. 'unknown' is always valid. */
export type MarketplaceSensorId = KnownMarketplaceSensor | (string & {});

// ---------------------------------------------------------------------------
// Time & trend — shared across every entity.
// ---------------------------------------------------------------------------

/** The window a piece of Marketplace Intelligence describes. */
export interface MarketplaceTimeWindow {
  startAt: Date;
  endAt: Date;
  /** Human-readable label, e.g. 'last_7_days', 'yesterday'. */
  label?: string;
}

/** Direction of change for a tracked metric. 'unknown' is a first-class,
 * honest state when there is not enough evidence to call a direction. */
export type MarketplaceTrendDirection = 'improving' | 'stable' | 'declining' | 'unknown';

/** A single tracked trend for one metric on one entity. */
export interface MarketplaceTrend {
  /** The metric name this trend concerns, e.g. 'bid_win_rate', 'net_profit'. */
  metric: string;
  direction: MarketplaceTrendDirection;
  /** Percent change vs. the comparison window, when computable. */
  changePercent?: number;
  /** The window this trend was compared against. */
  comparedTo?: MarketplaceTimeWindow;
}

/** Coarse health band for an entity or the marketplace as a whole. 'unknown'
 * is valid and expected when there is insufficient evidence to grade health. */
export type MarketplaceHealth = 'healthy' | 'watch' | 'at_risk' | 'critical' | 'unknown';

// ---------------------------------------------------------------------------
// Common entity envelope — every Campaign/Buyer/Source/Vendor Intelligence
// object shares this shape so consumers can treat them uniformly.
// ---------------------------------------------------------------------------

/** The fields every Marketplace Intelligence entity carries, regardless of
 * which sensor(s) produced it. Domain-specific interfaces extend this. */
export interface MarketplaceEntityIntelligence extends TenantScope {
  /** Stable identifier of this entity within its domain (campaign/buyer/etc). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Which sensor(s) this entity's facts were derived from. */
  sensor: MarketplaceSensorId;
  /** The window this snapshot of the entity describes. */
  timeWindow: MarketplaceTimeWindow;
  /** Confidence in this entity's intelligence as a whole, [0,1]. */
  confidence: Confidence;
  /** Tracked trends for this entity's key metrics. */
  trends: ReadonlyArray<MarketplaceTrend>;
  /** Recommendations consumed from the existing Brain — never generated here. */
  recommendations: ReadonlyArray<RecommendationEnvelope>;
  /** Open questions the Brain/model could not resolve for this entity. */
  unknowns: ReadonlyArray<string>;
  /** Evidence that would most increase confidence if collected. */
  missingEvidence: ReadonlyArray<string>;
  metadata?: Metadata;
}

/** Generic routing-performance shape reused by Buyer and Vendor Intelligence. */
export interface MarketplaceRoutingPerformance {
  routedCalls?: number;
  acceptedCalls?: number;
  rejectedCalls?: number;
  avgResponseMs?: number;
}

/** A single named reason bids/calls were rejected, with an open string `reason`
 * so new sensors can introduce new reasons without a model change. */
export interface MarketplaceRejectReason {
  reason: string;
  count?: number;
}
