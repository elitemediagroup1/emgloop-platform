// @emgloop/marketplace-intelligence — Profitability.
//
// PR #43. Pure domain representation of marketplace profitability. No
// calculations are performed here — this type only names what a
// profitability snapshot looks like; deriving/aggregating these values from
// sensor facts is a separate, later decision made outside this canonical
// model (mirroring the non-invasive precedent set by
// packages/brain/src/call-handling-metrics-assembler.ts).

import type { TenantScope } from '@emgloop/shared';
import type { Confidence } from '@emgloop/brain';
import type { MarketplaceTimeWindow } from './common';

export interface MarketplaceProfitability extends TenantScope {
  timeWindow: MarketplaceTimeWindow;

  revenue?: number;
  payout?: number;
  cost?: number;
  telco?: number;
  grossProfit?: number;
  netProfit?: number;
  /** Percent margin. */
  margin?: number;

  confidence: Confidence;
  unknowns: ReadonlyArray<string>;
  missingEvidence: ReadonlyArray<string>;
}
