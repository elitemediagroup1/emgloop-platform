// Interactions as Activity -- the channel-fact adapter.
//
// Slice A2. `Interaction` is the authority for what happened on a channel: calls,
// website events and the notes a person writes. It is the record that knows whether
// a fact carried a contact identifier, so it is the record that decides an item's
// identity state -- and it never decides who the person is.
//
// AN INTAKE LINK IS NOT A PERSON (§3 rule 1). A fact whose `customerId` is set is
// reported with subject INTAKE_RECORD, which derives UNRESOLVED / INTAKE_LINK_CONTEXT.
// 77,339 calls were attached to legacy Customer rows by ingestion, 274 of them on the
// last seven digits of a number and 319 carrying a different number altogether. A
// `CustomerPartyLink` on that Intake Record does not make these facts a Party's
// activity, so this file never reads one, and never reads identity at all.
//
// PRESENCE, NOT VALUES. Whether the source kept a phone, email, visitor or session
// key decides the identity state. The values stay in the source: `metadata` holds
// the raw provider payload, which is why every item that has one says
// `rawValuesInSource: true` and why no title is ever built from `summary`.
//
// TIME IS NOT GUESSED. CallGrid refuses an event whose occurrence it cannot
// establish, so those rows are PROVIDER_REPORTED. The website path stamps the Loop
// clock when the payload carried no time (§6), so its basis is decided by whether a
// time key survived in what it kept, and the fallback says so as a limitation.

import type { PrismaClient, Interaction, InteractionKind } from '@prisma/client';
import {
  ACTIVITY_CONTRACT_VERSION,
  activityFilterIncludes,
  deriveIdentitySubject,
  type ActivityCategory,
  type ActivityItemV1,
  type ActivityOccurredAtBasis,
  type ActivitySensitivityClass,
  type ActivitySubjectRef,
  type ActivityTransport,
} from '@emgloop/shared';

import { interactionActorName, interactionActorType } from '../interaction.repository';
import {
  EMPTY_PAGE,
  admit,
  filteredCategories,
  hasAnyKey,
  keysetWhere,
  record,
  type ActivityAdapter,
  type ActivityAdapterPage,
  type ActivityAdapterRequest,
  type ActivityRequirement,
  type ActivitySubject,
} from './adapter';

const RECORD_TYPE = 'interaction';

const INTAKE_REQUIRES: readonly ActivityRequirement[] = [{ resource: 'customers', action: 'view' }];
const ORGANIZATION_REQUIRES: readonly ActivityRequirement[] = [
  { resource: 'customers', action: 'view' },
  { resource: 'intelligence', action: 'view' },
];

/**
 * Total by construction: a new `InteractionKind` does not compile until it is
 * classified (contract rule 1). A note is a FACT somebody reported, not a
 * COMMUNICATION -- nothing was exchanged with anyone.
 */
const CATEGORY: Record<InteractionKind, ActivityCategory> = {
  PHONE_CALL: 'COMMUNICATION',
  SMS: 'COMMUNICATION',
  EMAIL: 'COMMUNICATION',
  CHAT: 'COMMUNICATION',
  RESERVATION: 'FACT',
  APPOINTMENT: 'FACT',
  ORDER: 'FACT',
  FORM_SUBMISSION: 'FACT',
  REVIEW: 'FACT',
  PAYMENT: 'FACT',
  NOTE: 'FACT',
  OTHER: 'FACT',
};

const KINDS_BY_CATEGORY = (categories: readonly ActivityCategory[]): InteractionKind[] =>
  (Object.keys(CATEGORY) as InteractionKind[]).filter((kind) => categories.includes(CATEGORY[kind]));

/** Keys a caller identifier arrives under. Presence only -- see the header. */
const PHONE_KEYS = ['callerId', 'caller_number', 'from', 'from_number', 'fromNumber', 'phone', 'customer_phone', 'tel'];
const EMAIL_KEYS = ['email', 'customer_email', 'user_email'];
const VISITOR_KEYS = ['visitorId', 'visitor_id', 'anonymous_id', 'client_id', 'cookie_id'];
const SESSION_KEYS = ['sessionId', 'session_id', 'session'];
/**
 * The website path's own occurrence keys (`website.provider.ts`). A row that kept
 * none of them was stamped with the Loop clock at ingestion.
 */
const WEBSITE_TIME_KEYS = ['occurred_at', 'timestamp', 'time', 'created_at'];

const LIMITATION_LOOP_CLOCK = 'the source reported no occurrence time; this is when Loop received the event';
const LIMITATION_INTAKE_LINK = 'attached to a legacy Intake Record by ingestion, which is not an identification';

function timeBasis(row: Interaction, meta: Record<string, unknown>): { basis: ActivityOccurredAtBasis; transport: ActivityTransport | null; limitation: string | null } {
  // No provider: a person typed it in the CRM, and `occurredAt` is the moment they did.
  if (!row.provider) return { basis: 'LOOP_CLOCK', transport: 'HUMAN_ENTRY', limitation: null };
  // CallGrid rejects an event with no usable occurrence timestamp rather than
  // stamping the ingestion time, so a stored row's time is the provider's.
  if (row.provider.toLowerCase().includes('callgrid')) return { basis: 'PROVIDER_REPORTED', transport: null, limitation: null };
  if (hasAnyKey(meta, WEBSITE_TIME_KEYS)) return { basis: 'PROVIDER_REPORTED', transport: null, limitation: null };
  return { basis: 'LOOP_CLOCK', transport: null, limitation: LIMITATION_LOOP_CLOCK };
}

function subjectsOf(row: Interaction, meta: Record<string, unknown>): ActivitySubjectRef[] {
  const subjects: ActivitySubjectRef[] = [];
  if (row.customerId) {
    // The Intake Record IS the subject this fact was attached to. Its identifier
    // keys are not reported as a second subject: the attachment is the weaker
    // claim, and reporting both would state a stronger basis than the truth.
    subjects.push({ kind: 'INTAKE_RECORD', customerId: row.customerId });
  } else if (hasAnyKey(meta, PHONE_KEYS)) {
    subjects.push({ kind: 'UNRESOLVED_IDENTIFIER', identifierKind: 'PHONE', assertionMode: null, evidenceRef: null });
  } else if (hasAnyKey(meta, EMAIL_KEYS)) {
    subjects.push({ kind: 'UNRESOLVED_IDENTIFIER', identifierKind: 'EMAIL', assertionMode: null, evidenceRef: null });
  } else if (hasAnyKey(meta, VISITOR_KEYS)) {
    subjects.push({ kind: 'ANONYMOUS_CONTINUITY', continuity: 'VISITOR', property: propertyOf(meta), evidenceRef: null });
  } else if (hasAnyKey(meta, SESSION_KEYS)) {
    subjects.push({ kind: 'ANONYMOUS_CONTINUITY', continuity: 'SESSION', property: propertyOf(meta), evidenceRef: null });
  }
  if (row.conversationId) subjects.push({ kind: 'CONVERSATION', id: row.conversationId });
  return subjects;
}

/** The site a website event came from -- a property name, never a visitor value. */
function propertyOf(meta: Record<string, unknown>): string | null {
  const p = meta.property;
  return typeof p === 'string' && p.trim() !== '' ? p.trim() : null;
}

function sensitivityOf(row: Interaction, meta: Record<string, unknown>): { class: ActivitySensitivityClass; rawValuesInSource: boolean; contentInline: false } {
  const contact = hasAnyKey(meta, [...PHONE_KEYS, ...EMAIL_KEYS]);
  if (row.kind === 'NOTE') return { class: 'COMMUNICATION_CONTENT', rawValuesInSource: true, contentInline: false };
  if (contact) return { class: 'CONTACT_IDENTIFIER', rawValuesInSource: true, contentInline: false };
  return { class: 'OPERATIONAL', rawValuesInSource: Object.keys(meta).length > 0, contentInline: false };
}

/**
 * A title from closed vocabularies only: the kind, the channel and the direction the
 * source recorded. `summary` is free text an integration wrote and can contain a
 * caller's number, so it is never projected -- the source page shows it under its
 * own guard.
 */
function titleOf(row: Interaction): string {
  const kind = row.kind.toLowerCase().replace(/_/g, ' ');
  const direction = row.direction === 'INTERNAL' ? 'internal' : row.direction.toLowerCase();
  return `${direction} ${kind}`;
}

function actorOf(row: Interaction): ActivityItemV1['actor'] {
  const declared = interactionActorType(row.payload);
  const name = interactionActorName(row.payload);
  if (declared === 'AI_AGENT') return { kind: 'AI_EMPLOYEE', userId: null, producer: name ?? null, producerVersion: null };
  if (declared === 'HUMAN_AGENT') {
    const actorUserId = record(row.payload).actorUserId;
    return { kind: 'HUMAN', userId: typeof actorUserId === 'string' ? actorUserId : null, producer: null, producerVersion: null };
  }
  if (row.provider) return { kind: 'PROVIDER', userId: null, producer: row.provider, producerVersion: null };
  return { kind: 'UNKNOWN', userId: null, producer: null, producerVersion: null };
}

export function interactionActivityItem(row: Interaction, requires: readonly ActivityRequirement[]): ActivityItemV1 {
  const meta = record(row.metadata);
  const time = timeBasis(row, meta);
  const subjects = subjectsOf(row, meta);
  const limitations = [time.limitation, row.customerId ? LIMITATION_INTAKE_LINK : null].filter((l): l is string => l !== null);
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: `${RECORD_TYPE}:${row.id}`,
    organizationId: row.organizationId,
    category: CATEGORY[row.kind],
    type: row.kind,
    authority: {
      domain: row.provider ? 'channel' : 'crm-intake',
      recordType: RECORD_TYPE,
      recordId: row.id,
      sequence: null,
      href: row.customerId ? `/crm/customers/${row.customerId}` : null,
    },
    time: {
      occurredAt: row.occurredAt.toISOString(),
      occurredAtBasis: time.basis,
      recordedAt: row.createdAt.toISOString(),
      window: null,
    },
    actor: actorOf(row),
    subjects,
    participants: [],
    identity: deriveIdentitySubject(subjects),
    provenance: {
      source: row.provider ?? 'operator',
      transport: time.transport,
      epistemic: row.provider ? 'RECORDED' : 'HUMAN_REPORTED',
      ruleId: null,
      ruleVersion: null,
      evidenceCount: null,
      limitations,
    },
    display: {
      title: titleOf(row),
      channel: row.channel,
      direction: row.direction,
      stateChange: null,
      semanticStatus: null,
    },
    access: { requires, workspace: null },
    sensitivity: sensitivityOf(row, meta),
  };
}

export class InteractionActivityAdapter implements ActivityAdapter {
  readonly domain = 'channel';
  readonly workspace = null;
  readonly categories: readonly ActivityCategory[] = ['COMMUNICATION', 'FACT'];

  constructor(private readonly prisma: PrismaClient) {}

  supports(subject: ActivitySubject): boolean {
    return subject.kind === 'ORGANIZATION' || subject.kind === 'INTAKE_RECORD';
  }

  /**
   * Two lanes, two guards, each matching the surface that shows these rows today.
   *
   * An Intake Record's timeline is exactly `/crm/customers/[id]`, which is
   * `customers:view`. An organization-wide read is not: unattached facts appear
   * only on the live call feed, which is `intelligence:view`. So the organization
   * lane demands BOTH, which is stricter than either surface and therefore cannot
   * show anyone a row they could not already reach. Authorization is the resource
   * grant; the live feed's 24-hour window is a product choice, not a boundary.
   */
  requiresFor(subject: ActivitySubject): readonly ActivityRequirement[] {
    return subject.kind === 'ORGANIZATION' ? ORGANIZATION_REQUIRES : INTAKE_REQUIRES;
  }

  async page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage> {
    const categories = filteredCategories(request.filter, this.categories, activityFilterIncludes);
    if (categories.length === 0 || !this.supports(request.subject)) return EMPTY_PAGE;
    const kinds = KINDS_BY_CATEGORY(categories);
    if (kinds.length === 0) return EMPTY_PAGE;

    const rows = await this.prisma.interaction.findMany({
      where: {
        organizationId: request.organizationId,
        ...(request.subject.kind === 'INTAKE_RECORD' ? { customerId: request.subject.customerId } : {}),
        kind: { in: kinds },
        ...keysetWhere('occurredAt', RECORD_TYPE, request.cursor),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: request.limit + 1,
    });

    const requires = this.requiresFor(request.subject);
    const { items } = admit(rows.map((row) => interactionActivityItem(row, requires)), request.cursor);
    return { items, rowsRead: rows.length, suppressed: 0, limitations: [] };
  }
}
