// Universal Activity -- the `activity.v1` item contract.
//
// Slice A1 (docs/architecture/universal-activity.md). Activity is a CONTRACT AND A
// PROJECTION, NOT AN AUTHORITY: an item is a reference to a record some source
// domain owns (a call, a decision observation, a work transition, an audit act),
// with an explanation. Adapters (slice A2) build items from each source under that
// source's own authorization; nothing stores them as truth, and nothing writes to
// Activity.
//
// IDENTITY IS NOT REQUIRED, AND NEVER INVENTED. Every item reports one identity
// subject state, derived at read time:
//   KNOWN_PARTY / KNOWN_COMPANY  only from a governed attribution (identity slice
//                                2.5); nothing produces one yet.
//   UNRESOLVED                   the fact carries a contact identifier no governed
//                                act has attributed, or it hangs off a legacy
//                                Intake Record (INTAKE_LINK_CONTEXT). An Intake
//                                link never makes a fact a Known Party.
//   ANONYMOUS                    only a first-party visitor or session key.
//   NOT_APPLICABLE               the item is about the business, a decision or work.
// Grouping facts by raw identifier values is identity matching and is forbidden.
//
// NO RAW VALUES, NO CONFIDENCE. Items carry no message body, phone number or email;
// content is fetched from the owning authority under its own guard. Interpretation
// shows its owner's semantic status (e.g. a Finding DEVELOPING), never a number.
//
// RESERVED SUBJECTS. RELATIONSHIP, OPPORTUNITY and CAMPAIGN are named so the
// contract is stable for design, and refused by the validator until their
// authorities exist.
//
// PURE. No clock, no I/O.

export const ACTIVITY_CONTRACT_VERSION = 'activity.v1' as const;

export const ACTIVITY_CATEGORIES = [
  'FACT',
  'COMMUNICATION',
  'STATE_CHANGE',
  'WORK',
  'SIGNAL',
  'FINDING',
  'RECOMMENDATION',
  'DECISION',
  'AUDIT',
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/** Categories that are interpretation, never recorded fact. */
export const INTERPRETIVE_ACTIVITY_CATEGORIES: readonly ActivityCategory[] = ['SIGNAL', 'FINDING', 'RECOMMENDATION'];

export const ACTIVITY_FILTERS = ['ALL', 'COMMUNICATIONS', 'WORK', 'INTELLIGENCE', 'CHANGES'] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

/** Which categories each primary filter shows. ALL shows every category. */
export const ACTIVITY_FILTER_CATEGORIES: Readonly<Record<ActivityFilter, readonly ActivityCategory[]>> = {
  ALL: ACTIVITY_CATEGORIES,
  COMMUNICATIONS: ['COMMUNICATION'],
  WORK: ['WORK'],
  INTELLIGENCE: ['SIGNAL', 'FINDING', 'RECOMMENDATION', 'DECISION'],
  CHANGES: ['STATE_CHANGE', 'AUDIT'],
};

export function activityFilterIncludes(filter: ActivityFilter, category: ActivityCategory): boolean {
  return (ACTIVITY_FILTER_CATEGORIES[filter] ?? []).includes(category);
}

export const IDENTITY_SUBJECT_STATES = ['KNOWN_PARTY', 'KNOWN_COMPANY', 'UNRESOLVED', 'ANONYMOUS', 'NOT_APPLICABLE'] as const;
export type IdentitySubjectState = (typeof IDENTITY_SUBJECT_STATES)[number];

export const IDENTITY_SUBJECT_BASES = [
  'GOVERNED_ATTRIBUTION',
  'INTAKE_LINK_CONTEXT',
  'FACT_IDENTIFIER_PRESENT',
  'CONTINUITY_KEY_PRESENT',
  'NONE',
] as const;
export type IdentitySubjectBasis = (typeof IDENTITY_SUBJECT_BASES)[number];

/** The only bases each identity subject state may stand on. */
export const IDENTITY_SUBJECT_STATE_BASES: Readonly<Record<IdentitySubjectState, readonly IdentitySubjectBasis[]>> = {
  KNOWN_PARTY: ['GOVERNED_ATTRIBUTION'],
  KNOWN_COMPANY: ['GOVERNED_ATTRIBUTION'],
  UNRESOLVED: ['FACT_IDENTIFIER_PRESENT', 'INTAKE_LINK_CONTEXT'],
  ANONYMOUS: ['CONTINUITY_KEY_PRESENT'],
  NOT_APPLICABLE: ['NONE'],
};

export const ACTIVITY_OCCURRED_AT_BASES = ['PROVIDER_REPORTED', 'LOOP_CLOCK', 'OPERATOR_STATED', 'REPORTING_WINDOW', 'UNKNOWN'] as const;
export type ActivityOccurredAtBasis = (typeof ACTIVITY_OCCURRED_AT_BASES)[number];

export const ACTIVITY_ACTOR_KINDS = ['HUMAN', 'AI_EMPLOYEE', 'SYSTEM', 'PROVIDER', 'MODEL', 'UNKNOWN'] as const;
export type ActivityActorKind = (typeof ACTIVITY_ACTOR_KINDS)[number];

export const ACTIVITY_EPISTEMIC_KINDS = ['RECORDED', 'HUMAN_REPORTED', 'DERIVED', 'INTERPRETED'] as const;
export type ActivityEpistemicKind = (typeof ACTIVITY_EPISTEMIC_KINDS)[number];

export const ACTIVITY_TRANSPORTS = ['WEBHOOK', 'API_POLL', 'API_RECOVERY', 'LOCAL_REPROCESS', 'HUMAN_ENTRY'] as const;
export type ActivityTransport = (typeof ACTIVITY_TRANSPORTS)[number];

export const ACTIVITY_SENSITIVITY_CLASSES = ['OPERATIONAL', 'CONTACT_IDENTIFIER', 'COMMUNICATION_CONTENT', 'WORKFORCE_PII'] as const;
export type ActivitySensitivityClass = (typeof ACTIVITY_SENSITIVITY_CLASSES)[number];

export const ACTIVITY_RESERVED_SUBJECT_KINDS = ['RELATIONSHIP', 'OPPORTUNITY', 'CAMPAIGN'] as const;

export type ActivitySubjectRef =
  | {
      readonly kind: 'PARTY';
      readonly partyId: string;
      readonly partyType: 'PERSON' | 'COMPANY';
      readonly reference: 'ESTABLISHED' | 'SUPERSEDED';
      readonly canonicalPartyId: string;
    }
  | { readonly kind: 'INTAKE_RECORD'; readonly customerId: string }
  | {
      readonly kind: 'UNRESOLVED_IDENTIFIER';
      readonly identifierKind: 'PHONE' | 'EMAIL';
      readonly assertionMode: string | null;
      /** Identity evidence reference once evidence exists (identity slice 2.3). Never the value. */
      readonly evidenceRef: string | null;
    }
  | {
      readonly kind: 'ANONYMOUS_CONTINUITY';
      readonly continuity: 'VISITOR' | 'SESSION';
      readonly property: string | null;
      readonly evidenceRef: string | null;
    }
  | { readonly kind: 'CONVERSATION' | 'WORK_ITEM' | 'CASE' | 'HEADLINE' | 'OBJECTIVE' | 'USER'; readonly id: string }
  | {
      /** A provider dimension (CallGrid buyer, vendor, source, campaign, destination). Not a Party. */
      readonly kind: 'PROVIDER_COUNTERPARTY';
      readonly role: 'BUYER' | 'VENDOR' | 'SOURCE' | 'CAMPAIGN' | 'DESTINATION';
      readonly provider: string;
      readonly externalId: string;
    }
  | { readonly kind: (typeof ACTIVITY_RESERVED_SUBJECT_KINDS)[number]; readonly id: string };

export interface ActivityItemV1 {
  readonly contractVersion: typeof ACTIVITY_CONTRACT_VERSION;
  /** Deterministic: `${authority.recordType}:${authority.recordId}` or with `:${sequence}`. */
  readonly key: string;
  readonly organizationId: string;
  readonly category: ActivityCategory;
  /** The source's own closed vocabulary (InteractionKind, observation type, audit action, …). */
  readonly type: string;
  readonly authority: {
    readonly domain: string;
    readonly recordType: string;
    readonly recordId: string;
    readonly sequence: number | null;
    /** The owning authority's own page, which enforces its own guard. */
    readonly href: string | null;
  };
  readonly time: {
    readonly occurredAt: string | null;
    readonly occurredAtBasis: ActivityOccurredAtBasis;
    readonly recordedAt: string;
    readonly window: { readonly start: string; readonly end: string } | null;
  };
  readonly actor: {
    readonly kind: ActivityActorKind;
    readonly userId: string | null;
    readonly producer: string | null;
    readonly producerVersion: string | null;
  };
  readonly subjects: readonly ActivitySubjectRef[];
  readonly participants: readonly ActivitySubjectRef[];
  readonly identity: { readonly state: IdentitySubjectState; readonly basis: IdentitySubjectBasis };
  readonly provenance: {
    readonly source: string;
    readonly transport: ActivityTransport | null;
    readonly epistemic: ActivityEpistemicKind;
    readonly ruleId: string | null;
    readonly ruleVersion: string | null;
    readonly evidenceCount: number | null;
    readonly limitations: readonly string[];
  };
  readonly display: {
    /** Human-readable. Never contains a raw contact value. */
    readonly title: string;
    readonly channel: string | null;
    readonly direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL' | null;
    readonly stateChange: { readonly from: string | null; readonly to: string | null } | null;
    /** The owning authority's semantic status label (e.g. DEVELOPING). Never a number. */
    readonly semanticStatus: string | null;
  };
  readonly access: {
    /** Every permission here must hold for the viewer; re-checked server-side per item. */
    readonly requires: readonly { readonly resource: string; readonly action: 'view' }[];
    readonly workspace: string | null;
  };
  readonly sensitivity: {
    readonly class: ActivitySensitivityClass;
    readonly rawValuesInSource: boolean;
    readonly contentInline: false;
  };
}

// --- Identity subject derivation ---------------------------------------------------

/**
 * The identity subject state an item's subjects support, most specific first:
 * a governed Party subject; then an unresolved identifier; then a legacy Intake
 * Record link; then continuity; otherwise not applicable. A PARTY subject is only
 * ever emitted for a governed attribution, so its presence is the attribution.
 */
export function deriveIdentitySubject(subjects: readonly ActivitySubjectRef[]): {
  state: IdentitySubjectState;
  basis: IdentitySubjectBasis;
} {
  const party = subjects.find((s): s is Extract<ActivitySubjectRef, { kind: 'PARTY' }> => s.kind === 'PARTY');
  if (party) return { state: party.partyType === 'COMPANY' ? 'KNOWN_COMPANY' : 'KNOWN_PARTY', basis: 'GOVERNED_ATTRIBUTION' };
  if (subjects.some((s) => s.kind === 'UNRESOLVED_IDENTIFIER')) return { state: 'UNRESOLVED', basis: 'FACT_IDENTIFIER_PRESENT' };
  if (subjects.some((s) => s.kind === 'INTAKE_RECORD')) return { state: 'UNRESOLVED', basis: 'INTAKE_LINK_CONTEXT' };
  if (subjects.some((s) => s.kind === 'ANONYMOUS_CONTINUITY')) return { state: 'ANONYMOUS', basis: 'CONTINUITY_KEY_PRESENT' };
  return { state: 'NOT_APPLICABLE', basis: 'NONE' };
}

// --- Ordering ----------------------------------------------------------------------

/** When an item sorts: occurrence when known, otherwise when Loop recorded it. */
export function activitySortInstant(item: Pick<ActivityItemV1, 'time'>): string {
  return item.time.occurredAt ?? item.time.recordedAt;
}

/** Newest first, then by key, so equal instants never reorder between renders. */
export function compareActivityItems(a: ActivityItemV1, b: ActivityItemV1): number {
  const ta = Date.parse(activitySortInstant(a));
  const tb = Date.parse(activitySortInstant(b));
  if (ta !== tb) return tb - ta;
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

// --- Validation --------------------------------------------------------------------

export const ACTIVITY_VIOLATIONS = [
  'WRONG_CONTRACT_VERSION',
  'MISSING_ORGANIZATION',
  'KEY_NOT_DERIVED_FROM_AUTHORITY',
  'UNKNOWN_CATEGORY',
  'INVALID_TIME',
  'UNKNOWN_TIME_WITHOUT_UNKNOWN_BASIS',
  'KNOWN_TIME_WITH_UNKNOWN_BASIS',
  'IDENTITY_BASIS_NOT_ALLOWED_FOR_STATE',
  'IDENTITY_STATE_NOT_SUPPORTED_BY_SUBJECTS',
  'RESERVED_SUBJECT_KIND',
  'INTERPRETATION_PRESENTED_AS_FACT',
  'RAW_CONTACT_VALUE_IN_TITLE',
  'NO_ACCESS_REQUIREMENT',
  'CONTENT_INLINE',
] as const;
export type ActivityViolation = (typeof ACTIVITY_VIOLATIONS)[number];

const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** Seven or more digits, optionally separated: a phone-number-shaped run. */
const PHONE_LIKE = /(?:\+?\d[\s().-]*){7,}/;

function isInstant(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && Number.isFinite(Date.parse(v));
}

/**
 * Every rule an item breaks. Empty means valid. Adapters assert this on what they
 * emit, so an item that invents identity, hides unknown time, presents
 * interpretation as fact or leaks a contact value fails in tests, not on a screen.
 */
export function validateActivityItem(item: ActivityItemV1): ActivityViolation[] {
  const out: ActivityViolation[] = [];
  if (item.contractVersion !== ACTIVITY_CONTRACT_VERSION) out.push('WRONG_CONTRACT_VERSION');
  if (typeof item.organizationId !== 'string' || item.organizationId.trim() === '') out.push('MISSING_ORGANIZATION');
  const base = `${item.authority.recordType}:${item.authority.recordId}`;
  const expectedKey = item.authority.sequence === null ? base : `${base}:${item.authority.sequence}`;
  if (item.key !== expectedKey) out.push('KEY_NOT_DERIVED_FROM_AUTHORITY');
  if (!(ACTIVITY_CATEGORIES as readonly string[]).includes(item.category)) out.push('UNKNOWN_CATEGORY');

  const t = item.time;
  if (!isInstant(t.recordedAt) || (t.occurredAt !== null && !isInstant(t.occurredAt))) out.push('INVALID_TIME');
  if (t.window && (!isInstant(t.window.start) || !isInstant(t.window.end))) out.push('INVALID_TIME');
  if (t.occurredAt === null && t.occurredAtBasis !== 'UNKNOWN') out.push('UNKNOWN_TIME_WITHOUT_UNKNOWN_BASIS');
  if (t.occurredAt !== null && t.occurredAtBasis === 'UNKNOWN') out.push('KNOWN_TIME_WITH_UNKNOWN_BASIS');

  const allowed = IDENTITY_SUBJECT_STATE_BASES[item.identity.state] ?? [];
  if (!allowed.includes(item.identity.basis)) out.push('IDENTITY_BASIS_NOT_ALLOWED_FOR_STATE');
  const derived = deriveIdentitySubject(item.subjects);
  if (derived.state !== item.identity.state || derived.basis !== item.identity.basis) {
    out.push('IDENTITY_STATE_NOT_SUPPORTED_BY_SUBJECTS');
  }
  const reserved = ACTIVITY_RESERVED_SUBJECT_KINDS as readonly string[];
  if ([...item.subjects, ...item.participants].some((s) => reserved.includes(s.kind))) out.push('RESERVED_SUBJECT_KIND');

  const interpretive = INTERPRETIVE_ACTIVITY_CATEGORIES.includes(item.category);
  if ((item.category === 'FACT' && item.provenance.epistemic === 'INTERPRETED') || (interpretive && item.provenance.epistemic === 'RECORDED')) {
    out.push('INTERPRETATION_PRESENTED_AS_FACT');
  }
  if (EMAIL_LIKE.test(item.display.title) || PHONE_LIKE.test(item.display.title)) out.push('RAW_CONTACT_VALUE_IN_TITLE');
  if (!Array.isArray(item.access.requires) || item.access.requires.length === 0) out.push('NO_ACCESS_REQUIREMENT');
  if ((item.sensitivity as { contentInline: unknown }).contentInline !== false) out.push('CONTENT_INLINE');
  return out;
}
