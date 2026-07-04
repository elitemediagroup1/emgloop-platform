// @emgloop/marketplace-intelligence — Marketplace Funnel.
//
// PR #43. Represents the complete marketplace lifecycle as an ORDERED,
// OPEN-ENDED set of stages, so any future funnel — the pay-per-call default
// (bids -> accepted -> won -> calls -> completed -> billable -> revenue ->
// profit), a Creator Intelligence funnel (views -> engagement -> brand deal ->
// payment), or anything else — is representable without redesigning this type.

import type { TenantScope } from '@emgloop/shared';
import type { Confidence } from '@emgloop/brain';
import type { MarketplaceTimeWindow } from './common';

/** A single stage in the marketplace lifecycle. `key`/`order` are open so any
 * future funnel can be represented without redesigning this type. */
export interface MarketplaceFunnelStage {
  /** Stable machine key, e.g. 'bids_received', 'accepted', 'won'. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Count at this stage. Undefined — never 0 — when unknown. */
  count?: number;
  /** Position in the funnel, ascending. */
  order: number;
}

/** The complete lifecycle view for one organization over one window. The
 * example stage set (bids -> accepted -> won -> calls -> completed ->
 * billable -> revenue -> profit) is a DEFAULT, not a constraint — `stages`
 * supports any ordered set of stages a future sensor/marketplace needs. */
export interface MarketplaceFunnel extends TenantScope {
  timeWindow: MarketplaceTimeWindow;
  stages: ReadonlyArray<MarketplaceFunnelStage>;
  confidence: Confidence;
  unknowns: ReadonlyArray<string>;
}
