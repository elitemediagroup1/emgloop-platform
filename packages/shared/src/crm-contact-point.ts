// CRM Contact Point -- how EMG reaches a Party, as a pure contract (PD-F-05, 2026-10-06).
//
// The decision record is docs/architecture/crm-contact-points.md.
//
// AN OPERATIONAL CRM RECORD, NOT IDENTITY. A Contact Point is a business email or phone a person
// recorded or imported for an established Party. It is NOT IdentityEvidence:
//   - it establishes nothing;
//   - it raises no tier and creates no evidence;
//   - it proves no PERSON <-> COMPANY affiliation;
//   - it is never VERIFIED because it was imported or recorded.
// The identity rule that EMAIL/PHONE OPERATOR_RECORDED is not an evidence class is untouched by
// this file.
//
// THE VALUE IS IMMUTABLE. A wrong value is voided or retired and the right one added. State is a
// projection of an append-only event log; nothing is deleted.
//
// THE VALUE NEVER TRAVELS. It is kept for authorized human display and compared only as a keyed
// hash. A reason that carries a contact value is refused (`crmContactPointReasonCarriesContactValue`),
// so the event log cannot become a second copy of the values.
//
// PURE. No clock, no I/O.

import type { PartyType } from './party';
import type { PartyReferenceResolution } from './party-reference';

export const CRM_CONTACT_POINT_CONTRACT_VERSION = 'crm-contact-point.v1' as const;

export const CRM_CONTACT_POINT_KINDS = ['EMAIL', 'PHONE'] as const;
export type CrmContactPointKind = (typeof CRM_CONTACT_POINT_KINDS)[number];

/**
 * What the value is the address OF. Each classification fits exactly the Party types listed, so
 * an unnamed address can never manufacture a Person: it sits on the Company as UNATTRIBUTED until a
 * person attributes it, by a governed act, to a PERSON.
 */
export const CRM_CONTACT_POINT_CLASSIFICATION_PARTY_TYPES: Readonly<Record<string, readonly PartyType[]>> = Object.freeze({
  /** A known person's own address. */
  INDIVIDUAL: Object.freeze(['PERSON'] as PartyType[]),
  /** A genuine shared or team address (press@, partnerships@). */
  ROLE_INBOX: Object.freeze(['COMPANY'] as PartyType[]),
  /** Looks individual, but no governed person attribution exists. */
  UNATTRIBUTED: Object.freeze(['COMPANY'] as PartyType[]),
});
export const CRM_CONTACT_POINT_CLASSIFICATIONS = ['INDIVIDUAL', 'ROLE_INBOX', 'UNATTRIBUTED'] as const;
export type CrmContactPointClassification = (typeof CRM_CONTACT_POINT_CLASSIFICATIONS)[number];

export const CRM_CONTACT_POINT_PURPOSES = ['BUSINESS_CONTACT'] as const;
export type CrmContactPointPurpose = (typeof CRM_CONTACT_POINT_PURPOSES)[number];

/** Provenance. Never a legal basis: Loop records how a value arrived, not a jurisdictional conclusion. */
export const CRM_CONTACT_POINT_BASES = ['OPERATOR_RECORDED', 'IMPORTED'] as const;
export type CrmContactPointBasis = (typeof CRM_CONTACT_POINT_BASES)[number];

export const CRM_CONTACT_POINT_STATES = ['ACTIVE', 'UNDELIVERABLE', 'RETIRED', 'VOIDED'] as const;
export type CrmContactPointState = (typeof CRM_CONTACT_POINT_STATES)[number];

/** The states that hold the (Party, kind, value) key. RETIRED and VOIDED release it. */
export const CRM_CONTACT_POINT_CURRENT_STATES: readonly CrmContactPointState[] = Object.freeze(['ACTIVE', 'UNDELIVERABLE']);

export function crmContactPointIsCurrent(state: string): boolean {
  return (CRM_CONTACT_POINT_CURRENT_STATES as readonly string[]).includes(state);
}

// --- Values -------------------------------------------------------------------------

export const CRM_CONTACT_POINT_EMAIL_MAX = 254;

export type CrmContactPointNormalization =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'EMPTY' | 'INVALID_EMAIL' | 'INVALID_PHONE' | 'UNKNOWN_KIND' };

/**
 * The one canonical form a value is stored and hashed in, or a refusal.
 *
 * - EMAIL: trimmed and lower-cased; exactly one "@" and a dotted domain.
 * - PHONE: international form only ("+" and 8-15 digits once spaces, dots, dashes and parentheses
 *   are removed). Loop does not guess a country, so a number without one is refused rather than
 *   assumed to be American.
 */
export function normalizeCrmContactPointValue(kind: string, raw: unknown): CrmContactPointNormalization {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'EMPTY' };
  if (kind === 'EMAIL') {
    const value = raw.trim().toLowerCase();
    if (value.length > CRM_CONTACT_POINT_EMAIL_MAX) return { ok: false, reason: 'INVALID_EMAIL' };
    if (!/^[^\s@<>(),;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
      return { ok: false, reason: 'INVALID_EMAIL' };
    }
    return { ok: true, value };
  }
  if (kind === 'PHONE') {
    const compact = raw.trim().replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(compact)) return { ok: false, reason: 'INVALID_PHONE' };
    return { ok: true, value: compact };
  }
  return { ok: false, reason: 'UNKNOWN_KIND' };
}

/** The namespace the keyed hash is taken under, so a Contact Point hash never equals an evidence hash. */
export function crmContactPointHashNamespace(kind: CrmContactPointKind): string {
  return `crm.contact_point.${kind}`;
}

/**
 * Whether free text carries something that looks like a contact value: an email address, or a run
 * of seven or more digits. Used to refuse reasons and source references, which travel to the event
 * log and the audit trail where a value must never be.
 */
export function crmContactPointReasonCarriesContactValue(text: string): boolean {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return true;
  // An ISO date or instant is a time, not a number someone dials; remove it before counting digits.
  const withoutDates = text.replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g, ' ');
  const digits = withoutDates.match(/\d[\d\s().+-]*\d/g) ?? [];
  return digits.some((run) => run.replace(/\D/g, '').length >= 7);
}

/** An import's opaque source reference: short, safe characters, no contact value. */
export function crmContactPointSourceRefValid(ref: unknown): boolean {
  return typeof ref === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(ref) && !crmContactPointReasonCarriesContactValue(ref);
}

// --- Adding --------------------------------------------------------------------------

export const CRM_CONTACT_POINT_ADD_VIOLATIONS = [
  'UNKNOWN_KIND',
  'UNKNOWN_CLASSIFICATION',
  'CLASSIFICATION_NOT_PERMITTED_FOR_PARTY_TYPE',
  'UNKNOWN_PURPOSE',
  'UNKNOWN_BASIS',
  'SOURCE_REF_REQUIRED',
  'SOURCE_REF_INVALID',
  'SOURCE_REF_NOT_PERMITTED',
] as const;
export type CrmContactPointAddViolation = (typeof CRM_CONTACT_POINT_ADD_VIOLATIONS)[number];

export interface CrmContactPointAddShape {
  readonly kind: string;
  readonly classification: string;
  readonly partyType: PartyType;
  readonly purpose: string;
  readonly basis: string;
  readonly sourceRef: string | null;
}

/** What is wrong with a new Contact Point's shape. The value is checked by the normalizer. */
export function validateCrmContactPointAdd(shape: CrmContactPointAddShape): CrmContactPointAddViolation[] {
  const out: CrmContactPointAddViolation[] = [];
  if (!(CRM_CONTACT_POINT_KINDS as readonly string[]).includes(shape.kind)) out.push('UNKNOWN_KIND');
  const permitted = CRM_CONTACT_POINT_CLASSIFICATION_PARTY_TYPES[shape.classification];
  if (!permitted) out.push('UNKNOWN_CLASSIFICATION');
  else if (!permitted.includes(shape.partyType)) out.push('CLASSIFICATION_NOT_PERMITTED_FOR_PARTY_TYPE');
  if (!(CRM_CONTACT_POINT_PURPOSES as readonly string[]).includes(shape.purpose)) out.push('UNKNOWN_PURPOSE');
  if (!(CRM_CONTACT_POINT_BASES as readonly string[]).includes(shape.basis)) out.push('UNKNOWN_BASIS');
  if (shape.basis === 'IMPORTED') {
    if (shape.sourceRef === null || shape.sourceRef === '') out.push('SOURCE_REF_REQUIRED');
    else if (!crmContactPointSourceRefValid(shape.sourceRef)) out.push('SOURCE_REF_INVALID');
  } else if (shape.sourceRef !== null) {
    out.push('SOURCE_REF_NOT_PERMITTED');
  }
  return out;
}

/** The key a current Contact Point is unique on within its organization. Hash only; never the value. */
export function crmContactPointCurrentKey(partyId: string, kind: CrmContactPointKind, valueHash: string): string {
  return `${partyId}|${kind}|${valueHash}`;
}

// --- Lifecycle -----------------------------------------------------------------------

export const CRM_CONTACT_POINT_EVENT_TYPES = [
  'CONTACT_POINT_ADDED',
  'CONTACT_POINT_MARKED_UNDELIVERABLE',
  'CONTACT_POINT_RETIRED',
  'CONTACT_POINT_VOIDED',
] as const;
export type CrmContactPointEventType = (typeof CRM_CONTACT_POINT_EVENT_TYPES)[number];

/** Every act after adding says no or undoes, so each needs a reason in the actor's own words. */
export const CRM_CONTACT_POINT_REASON_REQUIRED: readonly CrmContactPointEventType[] = Object.freeze([
  'CONTACT_POINT_MARKED_UNDELIVERABLE',
  'CONTACT_POINT_RETIRED',
  'CONTACT_POINT_VOIDED',
]);

/** The event a transition is, or null when it is not allowed. There is no reactivation (not approved). */
export function crmContactPointTransition(
  from: CrmContactPointState | null,
  to: CrmContactPointState,
): CrmContactPointEventType | null {
  if (from === null) return to === 'ACTIVE' ? 'CONTACT_POINT_ADDED' : null;
  if (from === 'ACTIVE' && to === 'UNDELIVERABLE') return 'CONTACT_POINT_MARKED_UNDELIVERABLE';
  if ((from === 'ACTIVE' || from === 'UNDELIVERABLE') && to === 'RETIRED') return 'CONTACT_POINT_RETIRED';
  if ((from === 'ACTIVE' || from === 'UNDELIVERABLE' || from === 'RETIRED') && to === 'VOIDED') return 'CONTACT_POINT_VOIDED';
  return null;
}

const EVENT_TARGET: Readonly<Record<CrmContactPointEventType, CrmContactPointState>> = Object.freeze({
  CONTACT_POINT_ADDED: 'ACTIVE',
  CONTACT_POINT_MARKED_UNDELIVERABLE: 'UNDELIVERABLE',
  CONTACT_POINT_RETIRED: 'RETIRED',
  CONTACT_POINT_VOIDED: 'VOIDED',
});

export type CrmContactPointProjection =
  | { readonly ok: true; readonly state: CrmContactPointState; readonly lastSequence: number }
  | { readonly ok: false; readonly reason: 'EMPTY_LOG' | 'SEQUENCE_GAP' | 'UNKNOWN_EVENT' | 'ILLEGAL_TRANSITION' };

/** The single definition of a Contact Point's state: fold its log in sequence order. Refused, never repaired. */
export function projectCrmContactPointState(events: readonly { readonly sequence: number; readonly type: string }[]): CrmContactPointProjection {
  if (events.length === 0) return { ok: false, reason: 'EMPTY_LOG' };
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  let state: CrmContactPointState | null = null;
  for (let i = 0; i < ordered.length; i += 1) {
    const e = ordered[i]!;
    if (e.sequence !== i + 1) return { ok: false, reason: 'SEQUENCE_GAP' };
    const target = (EVENT_TARGET as Readonly<Record<string, CrmContactPointState>>)[e.type];
    if (!target) return { ok: false, reason: 'UNKNOWN_EVENT' };
    if (crmContactPointTransition(state, target) !== e.type) return { ok: false, reason: 'ILLEGAL_TRANSITION' };
    state = target;
  }
  return { ok: true, state: state as CrmContactPointState, lastSequence: ordered.length };
}

// --- Authority (PD-F-05 grants) ------------------------------------------------------

export const CRM_CONTACT_POINT_ACTS = [
  /** Kind, classification, state and provenance. Never the value. */
  'VIEW_SUMMARY',
  /** The raw value. */
  'VIEW_VALUE',
  'ADD',
  'MARK_UNDELIVERABLE',
  'RETIRE',
  'VOID',
  /** Exact-match resolution for a writer. Returns a Party id, never a value. */
  'MATCH',
] as const;
export type CrmContactPointAct = (typeof CRM_CONTACT_POINT_ACTS)[number];

const HUMAN_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const;
const EMPLOYEE_AND_ABOVE = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const;
const MANAGER_AND_ABOVE = ['OWNER', 'ADMIN', 'MANAGER'] as const;
const OWNER_ADMIN = ['OWNER', 'ADMIN'] as const;

/** The approved grants (Product, 2026-10-06). AI_EMPLOYEE appears nowhere. */
export const CRM_CONTACT_POINT_ACT_ROLES: Readonly<Record<CrmContactPointAct, readonly string[]>> = Object.freeze({
  VIEW_SUMMARY: HUMAN_ROLES,
  VIEW_VALUE: EMPLOYEE_AND_ABOVE,
  ADD: EMPLOYEE_AND_ABOVE,
  MARK_UNDELIVERABLE: MANAGER_AND_ABOVE,
  RETIRE: MANAGER_AND_ABOVE,
  VOID: OWNER_ADMIN,
  MATCH: EMPLOYEE_AND_ABOVE,
});

/** Denied before the table is consulted, whatever a future edit of the table says. */
export const CRM_CONTACT_POINT_FORBIDDEN_ROLES: readonly string[] = Object.freeze(['AI_EMPLOYEE']);

/** Fails closed three ways: a person, a role that is not forbidden, a role the act grants. */
export function crmContactPointActPermitted(request: { readonly act: string; readonly role: string; readonly actorType: string }): boolean {
  if (request.actorType !== 'HUMAN') return false;
  if (CRM_CONTACT_POINT_FORBIDDEN_ROLES.includes(request.role)) return false;
  const roles = (CRM_CONTACT_POINT_ACT_ROLES as Readonly<Record<string, readonly string[]>>)[request.act];
  return Array.isArray(roles) && roles.includes(request.role);
}

// --- Exact matching ------------------------------------------------------------------

export const CRM_CONTACT_POINT_MATCH_OUTCOMES = [
  'MATCH',
  'NO_MATCH',
  'CONFLICT',
  'TYPE_MISMATCH',
  'PARTY_NOT_REFERENCEABLE',
  'INACTIVE_MATCH',
] as const;
export type CrmContactPointMatchOutcome = (typeof CRM_CONTACT_POINT_MATCH_OUTCOMES)[number];

export type CrmContactPointMatch =
  | { readonly outcome: 'MATCH'; readonly partyId: string }
  | { readonly outcome: Exclude<CrmContactPointMatchOutcome, 'MATCH'> };

/**
 * Whether one value may reuse an existing Party (`crm-contact-points.md` §7). `current` is every
 * ACTIVE or UNDELIVERABLE Contact Point holding the value's hash in this organization and kind;
 * `resolution` is the Party Reference answer for the single holder, when there is exactly one.
 * Anything but one ACTIVE point on one established, current Party of the required type is a
 * human-review outcome -- never a guess, never a new duplicate.
 */
export function decideCrmContactPointMatch(
  current: readonly { readonly partyId: string; readonly state: string }[],
  resolution: PartyReferenceResolution | null,
  requiredPartyType: PartyType,
): CrmContactPointMatch {
  const holders = new Set(current.filter((c) => crmContactPointIsCurrent(c.state)).map((c) => c.partyId));
  if (holders.size === 0) return { outcome: 'NO_MATCH' };
  if (holders.size > 1) return { outcome: 'CONFLICT' };
  if (!current.some((c) => c.state === 'ACTIVE')) return { outcome: 'INACTIVE_MATCH' };
  const [partyId] = [...holders];
  if (!resolution || resolution.state !== 'ESTABLISHED' || resolution.archived || resolution.partyId !== partyId) {
    return { outcome: 'PARTY_NOT_REFERENCEABLE' };
  }
  if (resolution.partyType !== requiredPartyType) return { outcome: 'TYPE_MISMATCH' };
  return { outcome: 'MATCH', partyId: partyId! };
}

// --- Retention (PD-F-05 item 5) -------------------------------------------------------

export interface CrmContactPointRetentionPolicy {
  /** How long an ACTIVE point is kept after its anchor. */
  readonly months: number;
  /** The latest recorded human contact, or the time the point was added when none is recorded. */
  readonly anchor: 'LATEST_HUMAN_CONTACT_ELSE_ADDED';
}

/** Policies by key. A row stores its key, so a later per-organization policy is a new key, not a rewrite. */
export const CRM_CONTACT_POINT_RETENTION_POLICIES: Readonly<Record<string, CrmContactPointRetentionPolicy>> = Object.freeze({
  'crm.contact_point.retention.v1': Object.freeze({ months: 36, anchor: 'LATEST_HUMAN_CONTACT_ELSE_ADDED' as const }),
});
export const CRM_CONTACT_POINT_DEFAULT_RETENTION_POLICY = 'crm.contact_point.retention.v1';

/**
 * The instant the raw value may be removed under its policy, or null when the policy is unknown --
 * an unknown policy keeps the value rather than guessing a date. Computed, never stored. Nothing
 * purges on it yet (PD-F-05: no automatic purge in the first slice).
 */
export function crmContactPointRetainUntil(point: {
  readonly retentionPolicy: string;
  readonly lastHumanContactAt: Date | null;
  readonly addedAt: Date;
}): Date | null {
  const policy = CRM_CONTACT_POINT_RETENTION_POLICIES[point.retentionPolicy];
  if (!policy) return null;
  const anchor = point.lastHumanContactAt ?? point.addedAt;
  const out = new Date(anchor.getTime());
  out.setUTCMonth(out.getUTCMonth() + policy.months);
  return out;
}

// --- Read model -----------------------------------------------------------------------

export interface CrmContactPointViewV1 {
  readonly contractVersion: typeof CRM_CONTACT_POINT_CONTRACT_VERSION;
  readonly id: string;
  readonly kind: CrmContactPointKind;
  readonly classification: CrmContactPointClassification;
  readonly purpose: CrmContactPointPurpose;
  readonly basis: CrmContactPointBasis;
  readonly state: CrmContactPointState;
  /** Always UNVERIFIED: nothing in Loop verifies a contact value yet. */
  readonly verification: 'UNVERIFIED';
  /**
   * The value, only when the viewer holds VIEW_VALUE and it has not been erased. Otherwise null --
   * and `valueWithheld` says why there is nothing to show.
   */
  readonly value: string | null;
  readonly valueWithheld: 'NOT_PERMITTED' | 'ERASED' | null;
  readonly addedAt: string;
  readonly addedByUserId: string | null;
  readonly retainUntil: string | null;
}
