// @emgloop/marketplace-intelligence — Vendor Intelligence.
//
// PR #43. Business-language view of a vendor's marketplace contribution
// (traffic, routing, revenue, profitability, quality).

import type {
  MarketplaceEntityIntelligence,
  MarketplaceHealth,
  MarketplaceRoutingPerformance,
} from './common';

export interface VendorIntelligence extends MarketplaceEntityIntelligence {
  vendorId: string;
  vendorName: string;

  /** Share of total marketplace traffic/volume this vendor contributes. */
  trafficContribution?: number;
  routingPerformance?: MarketplaceRoutingPerformance;

  revenue?: number;
  profit?: number;
  quality?: MarketplaceHealth;
}
