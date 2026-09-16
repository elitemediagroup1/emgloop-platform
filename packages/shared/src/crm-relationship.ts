// CRM Relationship -- a durable commercial connection, as a pure contract.
//
// Slice R1 (docs/architecture/relationship-participant.md; Product decisions
// PD-F-01..04, 2026-09-15). The canonical commercial Relationship is a NEW governed
// CRM authority (PD-I2-06); nothing here reads or writes the dormant
// `IdentityRelationship`.
//
// A FACT ABOUT THE BUSINESS, ASSERTED BY A PERSON. A Relationship says a commercial
// connection exists or existed, for a declared purpose (its kind). It is never
// inferred by a machine, never a pursuit (Opportunity), a program (Campaign), a
// contract or payment (Accounting), and never an identity link. Health and "at
// risk" are Commercial Intelligence interpretations that attach by reference.
//
// THE TENANT IS NEVER A PARTY (PD-F-01). An OWN kind connects the tenant -- the
// implicit owning side -- with one counterparty Party. A THIRD_PARTY kind connects
// two Parties inside the tenant's CRM context. No self-Company Party exists.
//
// DIRECTION LIVES IN THE KIND'S SIDES; CAPACITY LIVES IN THE PARTICIPANT ROLE. A kind
// declares its sides and their labels ("represents" / "is represented by") and
// which Party types each side permits. What a Party is commercially (Agency,
// Brand, Creator…) is its Participant role (`crm-participant.ts`).
//
// LIFECYCLE IS A PROJECTION. ACTIVE, ENDED (was true, has stopped) and VOIDED
// (was never true, entered in error) are derived from an append-only event log by
// `projectCrmRelationshipState`; there is no PROSPECTIVE state (PD-F-02) and no
// separate archive.
//
// PURE. No clock, no I/O.

import type { PartyType } from './party';
import { IDENTITY_ACTOR_TYPES, type IdentityActorType } from './identity-authority';

export const CRM_RELATIONSHIP_CONTRACT_VERSION = 'crm-relationship.v1' as const;

export const CRM_RELATIONSHIP_STRUCTURES = ['OWN', 'THIRD_PARTY'] as const;
export type CrmRelationshipStructure = (typeof CRM_RELATIONSHIP_STRUCTURES)[number];

export const CRM_RELATIONSHIP_SIDES = ['COUNTERPARTY', 'A', 'B'] as const;
export type CrmRelationshipSide = (typeof CRM_RELATIONSHIP_SIDES)[number];

export interface CrmRelationshipSideDefinition {
  readonly side: CrmRelationshipSide;
  /** How the side reads, e.g. "represents". */
  readonly label: string;
  readonly partyTypes: readonly PartyType[];
}

export interface CrmRelationshipKindDefinition {
  readonly kind: string;
  readonly structure: CrmRelationshipStructure;
  /** Both sides read the same; the side order carries no meaning. */
  readonly symmetric: boolean;
  readonly label: string;
  readonly sides: readonly CrmRelationshipSideDefinition[];
}

const EITHER: readonly PartyType[] = ['PERSON', 'COMPANY'];

const KINDS: readonly CrmRelationshipKindDefinition[] = [
  { kind: 'CLIENT', structure: 'OWN', symmetric: false, label: 'Client', sides: [{ side: 'COUNTERPARTY', label: 'is a client of the workspace', partyTypes: EITHER }] },
  { kind: 'SUPPLIER', structure: 'OWN', symmetric: false, label: 'Supplier', sides: [{ side: 'COUNTERPARTY', label: 'supplies the workspace', partyTypes: EITHER }] },
  { kind: 'TALENT_REPRESENTATION', structure: 'OWN', symmetric: false, label: 'Talent representation', sides: [{ side: 'COUNTERPARTY', label: 'is represented by the workspace', partyTypes: ['PERSON'] }] },
  { kind: 'PARTNER', structure: 'OWN', symmetric: false, label: 'Partner', sides: [{ side: 'COUNTERPARTY', label: 'partners with the workspace', partyTypes: EITHER }] },
  { kind: 'REPRESENTATION', structure: 'THIRD_PARTY', symmetric: false, label: 'Representation', sides: [{ side: 'A', label: 'represents', partyTypes: EITHER }, { side: 'B', label: 'is represented by', partyTypes: EITHER }] },
  { kind: 'SUPPLY', structure: 'THIRD_PARTY', symmetric: false, label: 'Supply', sides: [{ side: 'A', label: 'supplies', partyTypes: EITHER }, { side: 'B', label: 'is supplied by', partyTypes: EITHER }] },
  { kind: 'AFFILIATION', structure: 'THIRD_PARTY', symmetric: false, label: 'Affiliation', sides: [{ side: 'A', label: 'is affiliated with', partyTypes: ['PERSON'] }, { side: 'B', label: 'has affiliate', partyTypes: ['COMPANY'] }] },
  { kind: 'PARTNERSHIP', structure: 'THIRD_PARTY', symmetric: true, label: 'Partnership', sides: [{ side: 'A', label: 'partners with', partyTypes: EITHER }, { side: 'B', label: 'partners with', partyTypes: EITHER }] },
];

/** The governed kind vocabulary (PD-F-03). Frozen; additions are a reviewed contract change, not a migration. */
export const CRM_RELATIONSHIP_KIND_DEFINITIONS: readonly CrmRelationshipKindDefinition[] = Object.freeze(
  KINDS.map((k) =>
    Object.freeze({ ...k, sides: Object.freeze(k.sides.map((s) => Object.freeze({ ...s, partyTypes: Object.freeze([...s.partyTypes]) }))) }),
  ),
);

export const CRM_RELATIONSHIP_KINDS = CRM_RELATIONSHIP_KIND_DEFINITIONS.map((k) => k.kind);

export function crmRelationshipKind(kind: unknown): CrmRelationshipKindDefinition | null {
  return CRM_RELATIONSHIP_KIND_DEFINITIONS.find((k) => k.kind === kind) ?? null;
}

// --- Sides and identity ------------------------------------------------------------

export interface CrmRelationshipSideAssignment {
  readonly side: CrmRelationshipSide;
  readonly partyId: string;
  readonly partyType: PartyType;
}

export const CRM_RELATIONSHIP_SIDE_VIOLATIONS = [
  'UNKNOWN_KIND',
  'SIDES_DO_NOT_MATCH_KIND',
  'PARTY_TYPE_NOT_PERMITTED_FOR_SIDE',
  'SAME_PARTY_ON_BOTH_SIDES',
  'MISSING_PARTY_ID',
] as const;
export type CrmRelationshipSideViolation = (typeof CRM_RELATIONSHIP_SIDE_VIOLATIONS)[number];

/**
 * What is wrong with a kind and its side Parties. The caller has already resolved
 * every Party through the Party Reference contract (established, current, same
 * organization); this checks only the commercial shape.
 */
export function validateCrmRelationshipSides(
  kind: string,
  sides: readonly CrmRelationshipSideAssignment[],
): CrmRelationshipSideViolation[] {
  const def = crmRelationshipKind(kind);
  if (!def) return ['UNKNOWN_KIND'];
  const out: CrmRelationshipSideViolation[] = [];
  const expected = def.sides.map((s) => s.side).sort();
  const given = sides.map((s) => s.side).sort();
  if (expected.length !== given.length || expected.some((s, i) => s !== given[i])) out.push('SIDES_DO_NOT_MATCH_KIND');
  for (const assignment of sides) {
    if (typeof assignment.partyId !== 'string' || assignment.partyId.trim() === '') out.push('MISSING_PARTY_ID');
    const sideDef = def.sides.find((s) => s.side === assignment.side);
    if (sideDef && !sideDef.partyTypes.includes(assignment.partyType)) out.push('PARTY_TYPE_NOT_PERMITTED_FOR_SIDE');
  }
  const ids = sides.map((s) => s.partyId);
  if (new Set(ids).size !== ids.length) out.push('SAME_PARTY_ON_BOTH_SIDES');
  return [...new Set(out)];
}

/**
 * The natural key a non-VOIDED Relationship is unique on within its organization:
 * the kind and its side Parties -- ordered for a directed kind, order-free for a
 * symmetric one. An ENDED Relationship keeps its key, so renewing reactivates it.
 */
export function crmRelationshipNaturalKey(kind: string, sides: readonly CrmRelationshipSideAssignment[]): string {
  const def = crmRelationshipKind(kind);
  const parts = sides.map((s) => `${s.side}:${s.partyId}`);
  if (def?.symmetric) {
    return `${kind}|${sides.map((s) => s.partyId).sort().join('|')}`;
  }
  return `${kind}|${parts.sort().join('|')}`;
}

// --- What may change after creation (section 3.3) -----------------------------------

/**
 * Fixed for the life of the record. Getting any of these wrong is corrected by
 * VOID and create again, never by an edit: a Relationship between different
 * Parties, or of a different kind, is a different fact.
 */
export const CRM_RELATIONSHIP_IMMUTABLE_FIELDS = [
  'organizationId',
  'kind',
  'sides',
  'createdByUserId',
  'createdAt',
] as const;

/** Editable, each change an event. The owner is a User -- accountability, not a Party. */
export const CRM_RELATIONSHIP_EDITABLE_FIELDS = [
  'label',
  'description',
  'ownerUserId',
  'businessStartDate',
  'businessEndDate',
] as const;

export type CrmRelationshipField =
  | (typeof CRM_RELATIONSHIP_IMMUTABLE_FIELDS)[number]
  | (typeof CRM_RELATIONSHIP_EDITABLE_FIELDS)[number];

/** Fails closed: an unknown field is not editable. */
export function crmRelationshipFieldEditable(field: string): boolean {
  return (CRM_RELATIONSHIP_EDITABLE_FIELDS as readonly string[]).includes(field);
}

// --- Lifecycle ---------------------------------------------------------------------

export const CRM_RELATIONSHIP_STATES = ['ACTIVE', 'ENDED', 'VOIDED'] as const;
export type CrmRelationshipState = (typeof CRM_RELATIONSHIP_STATES)[number];

export const CRM_RELATIONSHIP_EVENT_TYPES = [
  'RELATIONSHIP_CREATED',
  'RELATIONSHIP_DETAILS_CHANGED',
  'RELATIONSHIP_OWNER_CHANGED',
  'RELATIONSHIP_ENDED',
  'RELATIONSHIP_REACTIVATED',
  'RELATIONSHIP_VOIDED',
  'PARTICIPANT_ADDED',
  'PARTICIPANT_CHANGED',
  'PARTICIPANT_ENDED',
  'PARTICIPANT_VOIDED',
] as const;
export type CrmRelationshipEventType = (typeof CRM_RELATIONSHIP_EVENT_TYPES)[number];

/** Events that say no or undo: a written reason is required and kept. */
export const CRM_RELATIONSHIP_REASON_REQUIRED: readonly CrmRelationshipEventType[] = [
  'RELATIONSHIP_ENDED',
  'RELATIONSHIP_VOIDED',
  'PARTICIPANT_ENDED',
  'PARTICIPANT_VOIDED',
];

/** Fails closed: an unknown event type is treated as needing a reason. */
export function crmRelationshipEventRequiresReason(type: string): boolean {
  if (!(CRM_RELATIONSHIP_EVENT_TYPES as readonly string[]).includes(type)) return true;
  return (CRM_RELATIONSHIP_REASON_REQUIRED as readonly string[]).includes(type);
}

/** The lifecycle event each transition is, or null when the transition is not allowed. */
export function crmRelationshipTransition(
  from: CrmRelationshipState | null,
  to: CrmRelationshipState,
): CrmRelationshipEventType | null {
  if (from === null) return to === 'ACTIVE' ? 'RELATIONSHIP_CREATED' : null;
  if (from === 'ACTIVE' && to === 'ENDED') return 'RELATIONSHIP_ENDED';
  if (from === 'ENDED' && to === 'ACTIVE') return 'RELATIONSHIP_REACTIVATED';
  if ((from === 'ACTIVE' || from === 'ENDED') && to === 'VOIDED') return 'RELATIONSHIP_VOIDED';
  return null;
}

export interface CrmRelationshipEventFact {
  readonly sequence: number;
  readonly type: string;
}

export type CrmRelationshipProjection =
  | { readonly ok: true; readonly state: CrmRelationshipState; readonly lastSequence: number }
  | { readonly ok: false; readonly reason: 'EMPTY_LOG' | 'NOT_CREATED_FIRST' | 'SEQUENCE_GAP' | 'UNKNOWN_EVENT' | 'ILLEGAL_TRANSITION' };

/**
 * The single definition of a Relationship's lifecycle state: fold its event log in
 * sequence order. Detail and participant events do not change the state. A log
 * that is not a valid history is refused, never repaired.
 */
export function projectCrmRelationshipState(events: readonly CrmRelationshipEventFact[]): CrmRelationshipProjection {
  if (events.length === 0) return { ok: false, reason: 'EMPTY_LOG' };
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  let state: CrmRelationshipState | null = null;
  for (let i = 0; i < ordered.length; i += 1) {
    const e = ordered[i]!;
    if (e.sequence !== i + 1) return { ok: false, reason: 'SEQUENCE_GAP' };
    if (!(CRM_RELATIONSHIP_EVENT_TYPES as readonly string[]).includes(e.type)) return { ok: false, reason: 'UNKNOWN_EVENT' };
    if (i === 0 && e.type !== 'RELATIONSHIP_CREATED') return { ok: false, reason: 'NOT_CREATED_FIRST' };
    const target: CrmRelationshipState | null =
      e.type === 'RELATIONSHIP_CREATED' || e.type === 'RELATIONSHIP_REACTIVATED'
        ? 'ACTIVE'
        : e.type === 'RELATIONSHIP_ENDED'
          ? 'ENDED'
          : e.type === 'RELATIONSHIP_VOIDED'
            ? 'VOIDED'
            : null;
    if (target === null) {
      if (state === null || state === 'VOIDED') return { ok: false, reason: 'ILLEGAL_TRANSITION' };
      continue;
    }
    if (crmRelationshipTransition(state, target) !== e.type) return { ok: false, reason: 'ILLEGAL_TRANSITION' };
    state = target;
  }
  return { ok: true, state: state as CrmRelationshipState, lastSequence: ordered.length };
}

// --- Authority (PD-F-04) -----------------------------------------------------------

export const CRM_RELATIONSHIP_ACTS = [
  'VIEW',
  'CREATE',
  'UPDATE_DETAILS',
  'CHANGE_OWNER',
  'ADD_PARTICIPANT',
  'CHANGE_PARTICIPANT',
  'END_RELATIONSHIP',
  'REACTIVATE_RELATIONSHIP',
  'END_PARTICIPANT',
  'VOID_RELATIONSHIP',
  'VOID_PARTICIPANT',
] as const;
export type CrmRelationshipAct = (typeof CRM_RELATIONSHIP_ACTS)[number];

const HUMAN_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const;
const EMPLOYEE_AND_ABOVE = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const;
const MANAGER_AND_ABOVE = ['OWNER', 'ADMIN', 'MANAGER'] as const;
const OWNER_ADMIN = ['OWNER', 'ADMIN'] as const;

/**
 * Which workspace roles may perform each act in the current release (PD-F-04).
 * AI_EMPLOYEE appears nowhere: it is not a human workspace role, so it may neither
 * view nor write. Reactivation follows the end grant. Grants are organization-wide
 * until a team model exists; a Participant never grants access. The service slice
 * (R3) binds this table to the authorization evaluator; it is not the security
 * boundary by itself.
 */
export const CRM_RELATIONSHIP_ACT_ROLES: Readonly<Record<CrmRelationshipAct, readonly string[]>> = Object.freeze({
  VIEW: HUMAN_ROLES,
  CREATE: EMPLOYEE_AND_ABOVE,
  UPDATE_DETAILS: EMPLOYEE_AND_ABOVE,
  CHANGE_OWNER: EMPLOYEE_AND_ABOVE,
  ADD_PARTICIPANT: EMPLOYEE_AND_ABOVE,
  CHANGE_PARTICIPANT: EMPLOYEE_AND_ABOVE,
  END_RELATIONSHIP: MANAGER_AND_ABOVE,
  REACTIVATE_RELATIONSHIP: MANAGER_AND_ABOVE,
  END_PARTICIPANT: MANAGER_AND_ABOVE,
  VOID_RELATIONSHIP: OWNER_ADMIN,
  VOID_PARTICIPANT: OWNER_ADMIN,
});

/** Fails closed: an unknown act or role is not permitted. */
export function crmRelationshipRolePermits(act: string, role: string): boolean {
  const roles = (CRM_RELATIONSHIP_ACT_ROLES as Readonly<Record<string, readonly string[]>>)[act];
  return Array.isArray(roles) && roles.includes(role);
}

/**
 * Roles that may never hold Relationship or Participant authority, whatever a
 * Permission row or a future edit of the table above says. The same hard denial
 * `identityResolution` uses (`IDENTITY_RESOLUTION_FORBIDDEN_ROLES`).
 */
export const CRM_RELATIONSHIP_FORBIDDEN_ROLES: readonly string[] = Object.freeze(['AI_EMPLOYEE']);

/**
 * Who may act at all. One vocabulary, the platform's own (`identity-authority.ts`),
 * so "machine" means the same thing in identity and in CRM.
 */
export const CRM_RELATIONSHIP_ACTOR_TYPES = IDENTITY_ACTOR_TYPES;
export type CrmRelationshipActorType = IdentityActorType;

/**
 * Every Relationship and Participant act is a HUMAN act (invariant 9). Ingestion,
 * rules, models and AI may recommend one through the governed Recommendation path;
 * none of them may perform one, and there is no act here they could perform.
 */
export const CRM_RELATIONSHIP_ACTOR_TYPES_PERMITTED: readonly CrmRelationshipActorType[] = Object.freeze(['HUMAN']);

export interface CrmRelationshipActRequest {
  readonly act: string;
  readonly role: string;
  readonly actorType: string;
}

/**
 * The single authority question this contract answers, fail-closed in three
 * independent ways: the actor must be a person, the role must not be forbidden,
 * and the role must hold the act's grant. R3 binds this to the authorization
 * evaluator (membership, object, purpose, sensitivity, policy); it is never the
 * security boundary on its own, and a UI must not treat it as one.
 */
export function crmRelationshipActPermitted(request: CrmRelationshipActRequest): boolean {
  if (!(CRM_RELATIONSHIP_ACTOR_TYPES_PERMITTED as readonly string[]).includes(request.actorType)) return false;
  if (CRM_RELATIONSHIP_FORBIDDEN_ROLES.includes(request.role)) return false;
  return crmRelationshipRolePermits(request.act, request.role);
}
