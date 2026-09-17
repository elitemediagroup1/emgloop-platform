// The Subject Display System: what a row, card, context card or header says about a subject.
//
// Charlie and Lexi's handoff (2026-09-16, pp. 13-14) defines one display system for
// lists, search, participant panels, drawers and rails. A card is a contextual
// projection of a subject, never a compressed copy of its record. This module turns
// governed read models into that projection; `_loop-os/subject-card.tsx` draws it.
//
// THE SIX PARTS, in order: canonical name; canonical type and identity or lifecycle
// state; why the subject appears here (a contextual role or reason); an affiliation or
// relationship; one current fact or attention state; one permission-aware action.
//
// RULES IT ENCODES:
//   - The TYPE is the canonical type only (Person, Company, Relationship, ...). Creator,
//     Buyer or Client Contact are contextual roles: they appear in the context line,
//     never as the type.
//   - A photo never establishes identity. There are no photos here, only initials and
//     neutral fallbacks.
//   - "No relationship found" and "relationships unavailable" are different facts, so a
//     fact carries what Loop knows about it, not only a sentence.
//   - A Relationship is its own subject, drawn with its sides inside one card.
//   - Unresolved activity never becomes a Person.
//
// GOVERNED WORDS ONLY. Relationship kinds and sides use the labels their authority
// defines (`kindLabel`). Participant roles and lifecycle states have no approved display
// labels yet, so `governedTerm` shows the governed value itself in sentence case
// (`CREATOR` → "Creator"). It never substitutes a synonym such as "Managed creator" or
// "Commercial lead": those mappings are an open product decision, not formatting.
//
// PURE. No I/O, no clock, no React.

import { formatInstant } from '@emgloop/shared';
import type {
  CrmPartyReferenceViewV1,
  CrmRelationshipListItemV1,
  PartyListItemV1,
  PartyRecordV1,
  PartyType,
} from '@emgloop/shared';

export const SUBJECT_KINDS = ['PERSON', 'COMPANY', 'RELATIONSHIP', 'WORKSPACE', 'INTAKE', 'UNRESOLVED_ACTIVITY'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Compact row (search, tables), standard card (lists), context card (rails, drawers), featured block (headers). */
export const SUBJECT_DENSITIES = ['row', 'card', 'context', 'featured'] as const;
export type SubjectDensity = (typeof SUBJECT_DENSITIES)[number];

/** Semantic tone: what a state means, never which product area owns it. */
export type SubjectTone = 'good' | 'attention' | 'neutral' | 'critical';

export interface SubjectState {
  readonly label: string;
  readonly tone: SubjectTone;
}

/**
 * One current fact. `known`: Loop established it. `none-found`: Loop looked and found
 * nothing. `unavailable`: Loop could not look (no authority, no projection, a failed
 * read). The last two must never read the same.
 */
export interface SubjectFact {
  readonly text: string;
  readonly knowledge: 'known' | 'none-found' | 'unavailable';
}

export interface SubjectAction {
  readonly label: string;
  /** Null when the viewer may not take it; `unavailableReason` then says why. */
  readonly href: string | null;
  readonly unavailableReason?: string;
}

export interface SubjectSide {
  readonly name: string;
  readonly named: boolean;
  readonly kind: SubjectKind;
}

export interface SubjectDisplay {
  readonly kind: SubjectKind;
  readonly key: string;
  /** 1. The canonical name, or an honest placeholder when none is recorded. */
  readonly name: string;
  /** False when `name` is a placeholder such as "Unnamed person". */
  readonly named: boolean;
  /** 2. The canonical type. */
  readonly typeLabel: string;
  /** 2. The identity or lifecycle state. */
  readonly state: SubjectState;
  /** 3. Why the subject appears on this surface. */
  readonly context: string | null;
  /** 4. An affiliation or relationship. */
  readonly affiliation: string | null;
  /** 5. One meaningful current fact or attention state. */
  readonly fact: SubjectFact | null;
  /** 6. Where the viewer can go from here. */
  readonly action: SubjectAction | null;
  /** A Relationship's sides, drawn inside its own card. */
  readonly sides?: readonly SubjectSide[];
}

const TYPE_LABEL: Record<SubjectKind, string> = {
  PERSON: 'Person',
  COMPANY: 'Company',
  RELATIONSHIP: 'Relationship',
  WORKSPACE: 'Workspace',
  INTAKE: 'Intake record',
  UNRESOLVED_ACTIVITY: 'Unresolved activity',
};

export function subjectTypeLabel(kind: SubjectKind): string {
  return TYPE_LABEL[kind];
}

export function partyKind(partyType: PartyType): 'PERSON' | 'COMPANY' {
  return partyType === 'COMPANY' ? 'COMPANY' : 'PERSON';
}

/** A governed value shown as itself, in sentence case: `PRIMARY_CONTACT` → "Primary contact". */
export function governedTerm(value: string): string {
  const words = value.trim().toLowerCase().split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return value;
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Up to two initials from a recorded name; a neutral mark when there is none. */
export function subjectInitials(name: string | null | undefined, kind: SubjectKind): string {
  // A relationship is a connection, not a party, and unresolved activity has no identity:
  // neither gets letters that would read as somebody's initials.
  if (kind === 'RELATIONSHIP') return '↔';
  if (kind === 'UNRESOLVED_ACTIVITY') return '?';
  const parts = (name ?? '').trim().split(/\s+/).filter((p) => /[\p{L}\p{N}]/u.test(p));
  if (parts.length === 0) return '·';
  const letter = (s: string) => (s.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase();
  const first = letter(parts[0]!);
  const last = parts.length > 1 ? letter(parts[parts.length - 1]!) : '';
  return first + last;
}

/**
 * A business date (`YYYY-MM-DD`, a calendar date with no time) for a person to read.
 * Formatted in UTC so the date never shifts with the reader's zone.
 */
export function businessDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatInstant(`${value}T00:00:00.000Z`, 'UTC', 'date') : value;
}

export function partyName(displayName: string | null, partyType: PartyType): { name: string; named: boolean } {
  const trimmed = displayName?.trim();
  if (trimmed) return { name: trimmed, named: true };
  return { name: partyType === 'COMPANY' ? 'Unnamed company' : 'Unnamed person', named: false };
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export type PartyIdentityState = 'ESTABLISHED' | 'NOT_ESTABLISHED' | 'SUPERSEDED' | 'ARCHIVED';

export function partyIdentityState(record: Pick<PartyRecordV1, 'reference' | 'archived'>): PartyIdentityState {
  if (record.reference.state === 'SUPERSEDED') return 'SUPERSEDED';
  if (record.archived) return 'ARCHIVED';
  return record.reference.state;
}

/** The handoff's words for the Person states it defines (p. 7). */
export function partyStateDisplay(state: PartyIdentityState): SubjectState {
  switch (state) {
    case 'ESTABLISHED':
      return { label: 'Established', tone: 'good' };
    case 'NOT_ESTABLISHED':
      return { label: 'Identity review required', tone: 'attention' };
    case 'SUPERSEDED':
      return { label: 'Superseded', tone: 'neutral' };
    case 'ARCHIVED':
      return { label: 'Archived', tone: 'neutral' };
  }
}

export function relationshipStateDisplay(state: string): SubjectState {
  return {
    label: governedTerm(state),
    tone: state === 'ACTIVE' ? 'good' : state === 'VOIDED' ? 'critical' : 'neutral',
  };
}

// ---------------------------------------------------------------------------
// A Party's relationship context
// ---------------------------------------------------------------------------

/** The Party a side or participant refers to now: the current Party for a superseded reference. */
export function crmPartyId(view: CrmPartyReferenceViewV1): string | null {
  return view.state === 'SUPERSEDED' ? view.canonicalPartyId : view.partyId;
}

/** A referenced Party's name, when the viewer may read it; an honest placeholder otherwise. */
export function sideName(view: CrmPartyReferenceViewV1, names: ReadonlyMap<string, string>): SubjectSide {
  if (view.state === 'UNAVAILABLE') return { name: 'Party unavailable', named: false, kind: 'PERSON' };
  const kind = partyKind(view.partyType);
  const recorded = names.get(crmPartyId(view) ?? '');
  if (recorded) return { name: recorded, named: true, kind };
  return { name: kind === 'COMPANY' ? 'A company' : 'A person', named: false, kind };
}

/** The other side of a relationship, from one Party's point of view: the workspace for its own relationships. */
export function counterpartName(
  item: CrmRelationshipListItemV1,
  partyId: string,
  names: ReadonlyMap<string, string>,
  workspaceName: string | null,
): string | null {
  if (item.structure === 'OWN') return workspaceName;
  const other = item.sides.find((s) => crmPartyId(s.party) !== partyId);
  if (!other) return null;
  const side = sideName(other.party, names);
  return side.named ? side.name : null;
}

/**
 * What the Relationships a Party takes part in say about it. `relationships === null`
 * means Loop could not read them for this viewer, which is not the same as reading
 * them and finding none.
 */
export interface PartyRelationshipContext {
  /** The Party's governed role in its first active relationship ("Creator"). */
  readonly role: string | null;
  /** A company the Party is affiliated with through a governed Affiliation. */
  readonly affiliation: string | null;
  /** "EMG · Talent representation": the counterpart and the governed kind. */
  readonly relationship: string | null;
  readonly fact: SubjectFact;
  readonly activeCount: number | null;
}

export function partyRelationshipContext(
  partyId: string,
  relationships: readonly CrmRelationshipListItemV1[] | null,
  names: ReadonlyMap<string, string>,
  workspaceName: string | null,
): PartyRelationshipContext {
  if (relationships === null) {
    return {
      role: null,
      affiliation: null,
      relationship: null,
      fact: { text: 'Relationship context unavailable', knowledge: 'unavailable' },
      activeCount: null,
    };
  }
  const active = relationships.filter((r) => r.state === 'ACTIVE');
  if (active.length === 0) {
    return {
      role: null,
      affiliation: null,
      relationship: null,
      fact: {
        text: relationships.length === 0 ? 'No relationship recorded' : 'No active relationship',
        knowledge: 'none-found',
      },
      activeCount: 0,
    };
  }
  // Prefer a relationship the Party is a side of; otherwise it takes part as a participant.
  const first = active.find((r) => r.sides.some((s) => crmPartyId(s.party) === partyId)) ?? active[0]!;
  const own = first.sides.find((s) => crmPartyId(s.party) === partyId) ?? null;
  const affiliationRel = active.find((r) => r.kind === 'AFFILIATION' && r.sides.some((s) => s.side === 'A' && crmPartyId(s.party) === partyId));
  const affiliation = affiliationRel ? counterpartName(affiliationRel, partyId, names, workspaceName) : null;
  const more = active.length > 1 ? ` · +${active.length - 1} more` : '';
  let relationship: string;
  if (own) {
    relationship = [counterpartName(first, partyId, names, workspaceName), first.kindLabel].filter(Boolean).join(' · ');
  } else {
    // Not a side: the relationship is between others, and this Party takes part in it.
    const sides = [
      ...(first.structure === 'OWN' ? [workspaceName ?? 'This workspace'] : []),
      ...first.sides.map((s) => sideName(s.party, names).name),
    ];
    relationship = `Participant in ${sides.join(' ↔ ')} · ${first.kindLabel}`;
  }
  return {
    // A participant's own role is not in a list item; the relationship line says "Participant in".
    role: own ? governedTerm(own.role) : null,
    affiliation,
    relationship: relationship + more,
    fact: {
      text: active.length === 1 ? '1 active relationship' : `${active.length} active relationships`,
      knowledge: 'known',
    },
    activeCount: active.length,
  };
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

function partySubject(
  base: { partyId: string; partyType: PartyType; displayName: string | null },
  state: SubjectState,
  context: PartyRelationshipContext,
  action: SubjectAction | null,
  withRelationship = true,
): SubjectDisplay {
  const kind = partyKind(base.partyType);
  const { name, named } = partyName(base.displayName, base.partyType);
  return {
    kind,
    key: base.partyId,
    name,
    named,
    typeLabel: subjectTypeLabel(kind),
    state,
    context: context.role,
    affiliation: withRelationship ? context.affiliation ?? context.relationship : context.affiliation,
    fact: context.fact,
    action,
  };
}

/**
 * A People or Companies list subject. List items are established, current and unarchived
 * by construction. In a table the relationship has its own column, so `withRelationship:
 * false` keeps it out of the line under the name.
 */
export function partyListSubject(
  item: PartyListItemV1,
  context: PartyRelationshipContext,
  href: string,
  options: { withRelationship?: boolean } = {},
): SubjectDisplay {
  const { name } = partyName(item.displayName, item.partyType);
  return partySubject(
    item,
    partyStateDisplay(item.establishment.established ? 'ESTABLISHED' : 'NOT_ESTABLISHED'),
    context,
    { label: `Open ${name}`, href },
    options.withRelationship ?? true,
  );
}

export function partyRecordSubject(record: PartyRecordV1, context: PartyRelationshipContext): SubjectDisplay {
  return partySubject(record, partyStateDisplay(partyIdentityState(record)), context, null);
}

export function relationshipSubject(
  item: CrmRelationshipListItemV1,
  names: ReadonlyMap<string, string>,
  workspaceName: string | null,
  href: string | null,
): SubjectDisplay {
  const sides: SubjectSide[] = [];
  if (item.structure === 'OWN') {
    sides.push({ name: workspaceName ?? 'This workspace', named: workspaceName !== null, kind: 'WORKSPACE' });
  }
  for (const side of item.sides) sides.push(sideName(side.party, names));
  const label = item.label?.trim() || null;
  const name = label ?? sides.map((s) => s.name).join(' ↔ ');
  const since = item.businessStartDate ? `Since ${item.businessStartDate.slice(0, 4)}` : null;
  return {
    kind: 'RELATIONSHIP',
    key: item.relationshipId,
    name,
    named: label !== null || sides.every((s) => s.named),
    typeLabel: subjectTypeLabel('RELATIONSHIP'),
    state: relationshipStateDisplay(item.state),
    context: [item.kindLabel, since].filter(Boolean).join(' · '),
    affiliation: label ? sides.map((s) => s.name).join(' ↔ ') : null,
    fact: {
      text: item.activeParticipantCount === 1 ? '1 active participant' : `${item.activeParticipantCount} active participants`,
      knowledge: 'known',
    },
    action: href ? { label: `Open ${name}`, href } : null,
    sides,
  };
}

export function workspaceSubject(org: { id: string; name: string }, fact: SubjectFact | null): SubjectDisplay {
  return {
    kind: 'WORKSPACE',
    key: org.id,
    name: org.name,
    named: true,
    typeLabel: subjectTypeLabel('WORKSPACE'),
    state: { label: 'Your workspace', tone: 'neutral' },
    context: 'Tenant and administration boundary',
    affiliation: null,
    fact,
    action: null,
  };
}

export function intakeSubject(
  intake: { id: string; name: string | null; source: string | null; status: string },
  href: string | null,
): SubjectDisplay {
  const name = intake.name?.trim() || 'Unnamed intake record';
  return {
    kind: 'INTAKE',
    key: intake.id,
    name,
    named: Boolean(intake.name?.trim()),
    typeLabel: subjectTypeLabel('INTAKE'),
    state: { label: governedTerm(intake.status), tone: 'neutral' },
    context: intake.source ? `Entered through ${intake.source}` : 'Source not recorded',
    affiliation: null,
    // An intake record is not a Person; that is the fact that matters wherever it appears.
    fact: { text: 'Not an established person', knowledge: 'known' },
    action: href ? { label: `Open ${name}`, href } : null,
  };
}

export function unresolvedActivitySubject(activity: {
  id: string;
  summary: string;
  source: string;
  identifierAvailable: boolean;
}): SubjectDisplay {
  return {
    kind: 'UNRESOLVED_ACTIVITY',
    key: activity.id,
    name: activity.summary,
    named: true,
    typeLabel: subjectTypeLabel('UNRESOLVED_ACTIVITY'),
    state: { label: 'Identity unresolved', tone: 'attention' },
    context: `From ${activity.source}`,
    affiliation: null,
    fact: activity.identifierAvailable
      ? { text: 'An identifier is available for review', knowledge: 'known' }
      : { text: 'No identifier recorded', knowledge: 'none-found' },
    action: null,
  };
}
