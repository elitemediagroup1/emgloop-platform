// @emgloop/brain — Trust & Data Boundary layer.
//
// Sprint 12: the permanent trust architecture that governs what data may be seen
// and what may cross tenant boundaries. The cardinal rule: NO customer records
// cross organizations. Only GENERALIZED, non-identifying learning may be shared
// at the network or platform tier.

import type { Visibility } from './types';

/** The three intelligence tiers, from most to least restricted. */
export type IntelligenceTier =
  | 'private_tenant' // belongs to one organization; never leaves it
  | 'emg_network'    // generalized patterns shared across EMG-operated orgs
  | 'platform';      // fully generalized, non-identifying platform intelligence

/** Map a tier to the visibility it permits. */
export const TIER_VISIBILITY: Record<IntelligenceTier, Visibility> = {
  private_tenant: 'private',
  emg_network: 'network',
  platform: 'platform',
};

/** A request to access a Brain object, evaluated by the Trust layer. */
export interface AccessRequest {
  /** Organization making the request. */
  requestingOrganizationId: string;
  /** Organization that owns the object. */
  ownerOrganizationId: string;
  /** Tier the object is classified at. */
  tier: IntelligenceTier;
  /** Whether the object contains identifying customer data. */
  containsCustomerRecord: boolean;
}

/** The decision returned by the Trust layer. */
export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Deterministic trust evaluation. The rules, in order:
 *  1. Same organization -> always allowed.
 *  2. Cross-organization + contains a customer record -> ALWAYS denied.
 *  3. Cross-organization + private_tenant tier -> denied.
 *  4. Cross-organization + network/platform tier (generalized) -> allowed.
 */
export function evaluateAccess(req: AccessRequest): AccessDecision {
  if (req.requestingOrganizationId === req.ownerOrganizationId) {
    return { allowed: true, reason: 'same-organization' };
  }
  if (req.containsCustomerRecord) {
    return { allowed: false, reason: 'customer-records-never-cross-tenants' };
  }
  if (req.tier === 'private_tenant') {
    return { allowed: false, reason: 'private-tenant-intelligence' };
  }
  return { allowed: true, reason: 'generalized-cross-tenant-learning' };
}

/** Contract for the Trust service (wraps evaluateAccess + auditing). */
export interface TrustService {
  evaluate(req: AccessRequest): AccessDecision;
}
