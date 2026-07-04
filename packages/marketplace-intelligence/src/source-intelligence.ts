// @emgloop/marketplace-intelligence — Source Intelligence.
//
// PR #43. Business-language view of a traffic source's marketplace
// performance (bids sent/accepted/won, reject reasons, fulfillment, quality).

import type {
  MarketplaceEntityIntelligence,
  MarketplaceHealth,
  MarketplaceRejectReason,
} from './common';

export interface SourceIntelligence extends MarketplaceEntityIntelligence {
  sourceId: string;
  sourceName: string;

  bidsSent?: number;
  bidsAccepted?: number;
  bidsWon?: number;

  rejectReasons?: ReadonlyArray<MarketplaceRejectReason>;

  /** Percent of expected traffic/bids actually fulfilled. */
  fulfillment?: number;
  callQuality?: MarketplaceHealth;

  revenueGenerated?: number;
  profit?: number;
}
