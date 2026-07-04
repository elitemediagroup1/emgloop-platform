// @emgloop/marketplace-intelligence — Campaign Intelligence.
//
// PR #43. A business-language view of a campaign's marketplace performance.
// Never named after a sensor concept (e.g. "CallGrid Campaign") — this is
// Campaign Intelligence, sensor-agnostic by design. Extends the shared
// MarketplaceEntityIntelligence envelope rather than redeclaring its fields.

import type { MarketplaceEntityIntelligence } from './common';

export interface CampaignIntelligence extends MarketplaceEntityIntelligence {
  campaignId: string;
  campaignName: string;

  bidsReceived?: number;
  bidsAccepted?: number;
  bidsWon?: number;

  completedCalls?: number;
  billableCalls?: number;
  convertedCalls?: number;

  revenue?: number;
  payout?: number;
  cost?: number;
  profit?: number;
  /** Percent margin, when computable from revenue/cost. */
  margin?: number;
}
