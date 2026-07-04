// @emgloop/marketplace-intelligence — the canonical Marketplace Intelligence
// snapshot.
//
// PR #43 (Marketplace Intelligence Canonical Domain Model). This is the single
// source of truth every future consumer reads: Admin Dashboard, Executive
// Dashboard, Daily Briefing, Brain Activity, Brain Briefing, Notifications,
// Workspace, Marketplace Intelligence pages, AI Employees, future Creator
// Intelligence, future Enterprise portals.
//
// Marketplace Intelligence does NOT generate its own recommendations. It
// consumes RecommendationEnvelope and BrainActivity from the existing Brain
// (packages/brain) — reusing established architecture rather than duplicating
// it. This file is additive, contracts-only: no runtime wiring, no UI, no
// database, no API endpoints, no schema changes, no LLM, no persistence.

import type { Metadata, TenantScope } from '@emgloop/shared';
import type { Confidence, RecommendationEnvelope } from '@emgloop/brain';
import type { MarketplaceHealth, MarketplaceTimeWindow } from './common';
import type { CampaignIntelligence } from './campaign-intelligence';
import type { BuyerIntelligence } from './buyer-intelligence';
import type { SourceIntelligence } from './source-intelligence';
import type { VendorIntelligence } from './vendor-intelligence';
import type { MarketplaceFunnel } from './marketplace-funnel';
import type { MarketplaceProfitability } from './profitability';
import type { MarketplaceBrainInsight } from './brain-insight';

/**
 * The canonical Marketplace Intelligence snapshot for one organization over
 * one time window. Every field is a reference to a domain-specific view
 * (Campaign/Buyer/Source/Vendor Intelligence, the Marketplace Funnel,
 * Profitability) or to existing Brain output (RecommendationEnvelope,
 * MarketplaceBrainInsight/BrainActivity) — nothing is invented, nothing is
 * duplicated.
 *
 * This model is intentionally generic enough that CallGrid, Ringba, Invoca,
 * Twilio, Salesforce, HubSpot, Meta, Google Ads, TikTok, or a future internal
 * bidding system can all populate it without changing this shape. Sensors
 * change; Marketplace Intelligence does not.
 */
export interface MarketplaceIntelligence extends TenantScope {
  /** When this snapshot was produced. */
  generatedAt: Date;
  /** The window this snapshot describes. */
  timeWindow: MarketplaceTimeWindow;
  /** Overall marketplace health; 'unknown' is valid and expected. */
  health: MarketplaceHealth;
  /** Overall confidence in this snapshot, [0,1]. */
  confidence: Confidence;
  /** Recommendations consumed from the existing Brain — never generated here. */
  recommendations: ReadonlyArray<RecommendationEnvelope>;
  /** Open questions the snapshot could not resolve. Never silently omitted. */
  unknowns: ReadonlyArray<string>;
  /** Evidence that would most increase confidence if collected. */
  missingEvidence: ReadonlyArray<string>;

  campaigns: ReadonlyArray<CampaignIntelligence>;
  buyers: ReadonlyArray<BuyerIntelligence>;
  sources: ReadonlyArray<SourceIntelligence>;
  vendors: ReadonlyArray<VendorIntelligence>;

  profitability: MarketplaceProfitability;
  funnel: MarketplaceFunnel;

  /** Explainable insights surfaced for this snapshot (aliases BrainActivity). */
  insights: ReadonlyArray<MarketplaceBrainInsight>;

  metadata?: Metadata;
}
