// @emgloop/brain — core types.
//
// Sprint 12: EMG Brain Foundation. These are the permanent, provider-agnostic
// primitives every Brain subsystem shares. No runtime dependencies beyond
// @emgloop/shared; no AI, no DB, no provider logic. Contracts only.

import type { Metadata, TenantScope } from '@emgloop/shared';

export type { Metadata, TenantScope } from '@emgloop/shared';

/** A confidence score in [0, 1]. Deterministic rules assign these in Sprint 12;
 *  model-derived scores can populate the same field later without API changes. */
export type Confidence = number;

/** Coarse priority used to rank signals, recommendations, and actions. */
export type Priority = 'low' | 'normal' | 'high' | 'critical';

/** Visibility scope for any Brain-owned object. Enforced by the Trust layer. */
export type Visibility = 'private' | 'network' | 'platform';

/** A single piece of supporting evidence behind a signal/recommendation. */
export interface Evidence {
  /** What kind of thing this evidence is (e.g. 'interaction', 'signal', 'event'). */
  kind: string;
  /** Stable reference id of the supporting record, if any. */
  ref?: string;
  /** Human-readable description of why this is evidence. */
  description: string;
  /** When the evidence was observed. */
  observedAt?: Date;
  /** Optional provider/source that produced the evidence. */
  source?: string;
}

/** Optional time-bounding for objects that decay or expire. */
export interface Lifespan {
  /** When the object became valid. */
  effectiveAt?: Date;
  /** When the object should be treated as stale/expired. */
  expiresAt?: Date;
  /** Optional half-life in seconds for confidence decay (advisory). */
  decayHalfLifeSeconds?: number;
}

/** Audit trail entry. Every mutable Brain object should accumulate these. */
export interface AuditEntry {
  at: Date;
  actor: string; // user id, ai employee id, or 'system'
  action: string; // 'created' | 'updated' | 'approved' | ...
  note?: string;
}

/** Common envelope fields for tenant-owned, auditable Brain objects. */
export interface BrainObjectBase extends TenantScope {
  id?: string;
  visibility: Visibility;
  confidence?: Confidence;
  lifespan?: Lifespan;
  version?: number;
  audit?: AuditEntry[];
  metadata?: Metadata;
}

/** Result of a deterministic Brain operation, mirroring shared Result. */
export interface BrainOutcome<T> {
  ok: boolean;
  value?: T;
  reason?: string;
}
