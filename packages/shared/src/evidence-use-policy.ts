// Identity evidence use policy -- nothing is produced until a person decided it may be.
//
// Identity Slice 2.0, a pure contract. The decision record is
// docs/architecture/identity-evidence-resolution.md (section 7 and PD-I2-01).
//
// PER CLASS, SET BY THE ORGANIZATION, NEVER ASSUMED. Hash-only identity evidence
// is approved architecturally. How long it is kept, and on what legal basis it is
// processed, are not Product assumptions and are not written into code: each
// evidence class (`identity-evidence.ts`) has its own policy, and until an
// organization records a retention period and a legal basis, both are UNSET.
//
// FAILS CLOSED. `mayProduceEvidence` is false for any of these:
//   - an absent policy, or a policy for a different class;
//   - a class outside the approved matrix, or one with no producing authority
//     (VERIFIED, AUTHENTICATED);
//   - a policy that is not ACTIVE or not in effect at the fact's instant;
//   - retention or legal basis UNSET;
//   - a malformed policy;
//   - a missing activation, or one that was not a human OWNER or ADMIN acting
//     under `identityResolution:approve`.
// Machine and AI never activate a policy.
//
// WHERE IT WILL LIVE. The existing `DataGovernancePolicy` (status, version,
// `retentionDays`, `requiresConsent`, effective dates), extended in 2.1b with the
// evidence class and a legal basis. This contract is the shape that extension
// must satisfy; nothing reads or writes a policy yet.
//
// A LEGAL BASIS IS NOT CONSENT CAPTURED. The basis is the organization's recorded
// decision for the class. `consentCaptured` is only what one fact captured, and it
// matters only when the policy requires consent.
//
// PURE. No clock, no I/O. The fact's instant is passed in.

import { identityEvidenceClassRule, type IdentityEvidenceClass } from './identity-evidence';

export const EVIDENCE_POLICY_UNSET = 'UNSET' as const;
export type EvidencePolicyUnset = typeof EVIDENCE_POLICY_UNSET;

/** Mirrors `GovernancePolicyStatus`. */
export const EVIDENCE_USE_POLICY_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;
export type EvidenceUsePolicyStatus = (typeof EVIDENCE_USE_POLICY_STATUSES)[number];

/**
 * The bases an organization may record. Mirrors `ConsentBasis` without NONE,
 * because "no basis" is UNSET, not a basis. Which one applies is the
 * organization's decision; nothing defaults it.
 */
export const EVIDENCE_LEGAL_BASES = [
  'CONSENT',
  'CONTRACT',
  'LEGITIMATE_INTEREST',
  'LEGAL_OBLIGATION',
  'VITAL_INTEREST',
  'PUBLIC_TASK',
] as const;
export type EvidenceLegalBasis = (typeof EVIDENCE_LEGAL_BASES)[number];

export interface EvidencePolicyActivation {
  readonly actorType: string;
  readonly userId: string;
  readonly role: string;
  /** The `identityResolution` action the activator held when activating. */
  readonly authorizedAction: string;
  readonly at: string;
}

export interface IdentityEvidenceUsePolicy {
  readonly evidenceClass: IdentityEvidenceClass;
  readonly status: EvidenceUsePolicyStatus;
  readonly version: number;
  readonly retention: EvidencePolicyUnset | { readonly days: number };
  readonly legalBasis:
    | EvidencePolicyUnset
    | {
        readonly basis: EvidenceLegalBasis;
        /** Where the organization recorded the decision, e.g. its notice or assessment. */
        readonly reference: string;
      };
  readonly requiresConsent: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly activation: EvidencePolicyActivation | null;
}

export interface EvidenceProductionFacts {
  readonly evidenceClass: IdentityEvidenceClass;
  /** When the fact occurred, as a UTC instant. */
  readonly at: string;
  /** The fact itself captured consent. */
  readonly consentCaptured: boolean;
}

export const EVIDENCE_POLICY_REFUSALS = [
  'ABSENT',
  'CLASS_MISMATCH',
  'CLASS_NOT_APPROVED',
  'CLASS_UNAVAILABLE',
  'INVALID',
  'NOT_ACTIVE',
  'NOT_ACTIVATED_BY_AUTHORIZED_HUMAN',
  'RETENTION_UNSET',
  'LEGAL_BASIS_UNSET',
  'NOT_IN_EFFECT',
  'CONSENT_NOT_CAPTURED',
] as const;
export type EvidencePolicyRefusal = (typeof EVIDENCE_POLICY_REFUSALS)[number];

export type EvidencePolicyDecision =
  | { readonly allowed: true; readonly policyVersion: number }
  | { readonly allowed: false; readonly refusal: EvidencePolicyRefusal };

const ACTIVATING_ROLES: readonly string[] = ['OWNER', 'ADMIN'];

function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function wellFormed(p: IdentityEvidenceUsePolicy): boolean {
  if (!(EVIDENCE_USE_POLICY_STATUSES as readonly string[]).includes(p.status)) return false;
  if (!Number.isInteger(p.version) || p.version < 1) return false;
  if (p.retention !== EVIDENCE_POLICY_UNSET) {
    if (typeof p.retention !== 'object' || p.retention === null) return false;
    if (!Number.isInteger(p.retention.days) || p.retention.days < 1) return false;
  }
  if (p.legalBasis !== EVIDENCE_POLICY_UNSET) {
    if (typeof p.legalBasis !== 'object' || p.legalBasis === null) return false;
    if (!(EVIDENCE_LEGAL_BASES as readonly string[]).includes(p.legalBasis.basis)) return false;
    if (!nonEmpty(p.legalBasis.reference)) return false;
  }
  if (typeof p.requiresConsent !== 'boolean') return false;
  const from = instant(p.effectiveFrom);
  if (from === null) return false;
  if (p.effectiveTo !== null) {
    const to = instant(p.effectiveTo);
    if (to === null || to <= from) return false;
  }
  return true;
}

function activatedByAuthorizedHuman(a: EvidencePolicyActivation | null): boolean {
  if (a === null || typeof a !== 'object') return false;
  return (
    a.actorType === 'HUMAN' &&
    nonEmpty(a.userId) &&
    ACTIVATING_ROLES.includes(a.role) &&
    a.authorizedAction === 'approve' &&
    instant(a.at) !== null
  );
}

/** The full decision, with the first reason production is refused. */
export function evidencePolicyDecision(
  policy: IdentityEvidenceUsePolicy | null | undefined,
  facts: EvidenceProductionFacts,
): EvidencePolicyDecision {
  const refuse = (refusal: EvidencePolicyRefusal): EvidencePolicyDecision => ({ allowed: false, refusal });

  if (policy === null || policy === undefined) return refuse('ABSENT');
  const rule = identityEvidenceClassRule(facts.evidenceClass);
  if (rule === null) return refuse('CLASS_NOT_APPROVED');
  if (!rule.available) return refuse('CLASS_UNAVAILABLE');
  if (
    typeof policy.evidenceClass !== 'object' ||
    policy.evidenceClass === null ||
    policy.evidenceClass.kind !== facts.evidenceClass.kind ||
    policy.evidenceClass.mode !== facts.evidenceClass.mode
  ) {
    return refuse('CLASS_MISMATCH');
  }
  if (!wellFormed(policy)) return refuse('INVALID');
  if (policy.status !== 'ACTIVE') return refuse('NOT_ACTIVE');
  if (!activatedByAuthorizedHuman(policy.activation)) return refuse('NOT_ACTIVATED_BY_AUTHORIZED_HUMAN');
  if (policy.retention === EVIDENCE_POLICY_UNSET) return refuse('RETENTION_UNSET');
  if (policy.legalBasis === EVIDENCE_POLICY_UNSET) return refuse('LEGAL_BASIS_UNSET');

  const at = instant(facts.at);
  if (at === null) return refuse('INVALID');
  const from = instant(policy.effectiveFrom) as number;
  const to = policy.effectiveTo === null ? null : instant(policy.effectiveTo);
  if (at < from || (to !== null && at >= to)) return refuse('NOT_IN_EFFECT');

  if (policy.requiresConsent && facts.consentCaptured !== true) return refuse('CONSENT_NOT_CAPTURED');

  return { allowed: true, policyVersion: policy.version };
}

/** Whether evidence of this class may be produced from this fact. Fails closed. */
export function mayProduceEvidence(
  policy: IdentityEvidenceUsePolicy | null | undefined,
  facts: EvidenceProductionFacts,
): boolean {
  return evidencePolicyDecision(policy, facts).allowed;
}
