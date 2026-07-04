// @emgloop/marketplace-intelligence — Buyer Intelligence.
//
// PR #43. Business-language view of a buyer's marketplace performance. Reuses
// DiagnosticAssessment from @emgloop/brain rather than redeclaring a diagnostic
// shape — a buyer's health/recommendations trace back to the same diagnostic
// engine every other Brain subject uses.

import type {
  MarketplaceEntityIntelligence,
  MarketplaceHealth,
  MarketplaceRoutingPerformance,
} from './common';
import type { DiagnosticAssessment } from '@emgloop/brain';

export interface BuyerIntelligence extends MarketplaceEntityIntelligence {
  buyerId: string;
  buyerName: string;
  health: MarketplaceHealth;

  acceptanceRate?: number;
  completionRate?: number;
  billableRate?: number;
  conversionRate?: number;

  revenue?: number;
  payout?: number;
  profit?: number;

  routingPerformance?: MarketplaceRoutingPerformance;

  /** Underlying diagnoses this buyer's health/recommendations were built from.
   * Reused from the existing Brain diagnostic engine — never redeclared. */
  diagnostics?: ReadonlyArray<DiagnosticAssessment>;
}
