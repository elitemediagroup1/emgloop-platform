// @emgloop/brain — Identity Resolution.
//
// Sprint 12: the canonical identity engine. Determines when multiple events
// belong to the same person or business across providers and channels. Today it
// resolves on phone / email / external id; the contract leaves room for future
// website identity and creator identity without breaking callers.
//
// Deterministic only — exact/normalized matching. No probabilistic ML in
// Sprint 12. Tenant-safe: identities never span organizations.

import type { Confidence, Evidence } from './types';

/** The kinds of identifier the engine can resolve on. */
export type IdentifierType =
  | 'phone'
  | 'email'
  | 'external_id'
  | 'website_visitor'
  | 'creator_handle';

/** A single identifier observed on an event. */
export interface Identifier {
  type: IdentifierType;
  /** Raw value as observed. */
  value: string;
  /** Normalized value used for matching (e.g. digits-only phone). */
  normalized?: string;
  /** Provider/source that supplied it. */
  source?: string;
}

/** Whether the resolved identity is a person or a business. */
export type IdentityKind = 'person' | 'business' | 'unknown';

/** A resolved canonical identity within a single organization. */
export interface ResolvedIdentity {
  organizationId: string;
  identityId: string;
  kind: IdentityKind;
  /** All identifiers linked to this identity. */
  identifiers: Identifier[];
  confidence: Confidence;
  evidence: Evidence[];
  /** True if a new identity was created during resolution. */
  created: boolean;
}

/** Input to a resolution request. */
export interface IdentityResolutionInput {
  organizationId: string;
  identifiers: Identifier[];
  /** Hint about the expected kind, if known. */
  kindHint?: IdentityKind;
}

/** Contract for the canonical Identity Resolution service. */
export interface IdentityResolutionService {
  /** Normalize a raw identifier (e.g. strip phone formatting, lowercase email). */
  normalize(identifier: Identifier): Identifier;
  /** Resolve identifiers to a canonical identity, creating one if needed.
   *  Deterministic: same inputs always resolve to the same identity. */
  resolve(input: IdentityResolutionInput): Promise<ResolvedIdentity>;
  /** Merge two identities that are later found to be the same (audited). */
  merge(
    organizationId: string,
    primaryId: string,
    secondaryId: string,
  ): Promise<ResolvedIdentity>;
}
