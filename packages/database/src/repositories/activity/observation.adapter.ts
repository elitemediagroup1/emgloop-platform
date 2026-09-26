// Decision and Case observations as Activity -- the gold-standard source.
//
// Slice A2. `OperationalObservation` is the only source that already records
// everything `activity.v1` asks for: when it happened, when Loop learned it, a
// monotonic sequence, and who did it. Nothing here has to be inferred.
//
// INTERPRETATION STAYS LABELLED. A detection is the engine's reading of a period,
// not a fact somebody witnessed; findings and recommendations are interpretation
// too. They are categorised SIGNAL / FINDING / RECOMMENDATION and marked
// INTERPRETED, so the contract's own validator refuses them if they are ever dressed
// up as recorded fact. The Case's semantic status travels as a label; there is no
// number anywhere, and there will not be one.
//
// TIME HAS THREE HONEST BASES. A row carrying a `detectionKey` is the engine's
// analysis of a named period, so its basis is REPORTING_WINDOW -- the period's own
// bounds are not stored, so `window` stays null rather than being invented. A human
// recording something after the fact states when it happened: OPERATOR_STATED.
// Everything else is the Loop clock.

import type { PrismaClient, OperationalObservation } from '@prisma/client';
import {
  ACTIVITY_CONTRACT_VERSION,
  activityFilterIncludes,
  deriveIdentitySubject,
  type ActivityCategory,
  type ActivityEpistemicKind,
  type ActivityItemV1,
  type ActivityOccurredAtBasis,
  type ActivitySubjectRef,
  type ObservationType,
} from '@emgloop/shared';

import {
  EMPTY_PAGE,
  admit,
  filteredCategories,
  keysetWhere,
  type ActivityAdapter,
  type ActivityAdapterPage,
  type ActivityAdapterRequest,
  type ActivityRequirement,
  type ActivitySubject,
} from './adapter';
import { CASE_ORGANIZATION_WHERE } from '@emgloop/shared';

const RECORD_TYPE = 'operational-observation';
const REQUIRES: readonly ActivityRequirement[] = [{ resource: 'commercialIntelligence', action: 'view' }];

/**
 * Total by construction (contract rule 1): a new observation type does not compile
 * until somebody decides what kind of activity it is. Lifecycle acts on a Case are
 * DECISION -- they are the Decision Engine's own log. The four that are somebody
 * else's reading of the world are separated out, and two that record a real contact
 * with a person are COMMUNICATION.
 */
const CATEGORY: Record<ObservationType, ActivityCategory> = {
  SITUATION_DETECTED: 'SIGNAL',
  SITUATION_RESIGHTED: 'SIGNAL',
  FINDING_RECORDED: 'FINDING',
  FINDING_SUPERSEDED: 'FINDING',
  RECOMMENDATION_RECORDED: 'RECOMMENDATION',
  RECOMMENDATION_SELECTED: 'RECOMMENDATION',
  RECOMMENDATION_DISMISSED: 'RECOMMENDATION',
  RECOMMENDATION_REVISED: 'RECOMMENDATION',
  CONTACT_ATTEMPTED: 'COMMUNICATION',
  CONTACT_COMPLETED: 'COMMUNICATION',
  REOPENED: 'DECISION',
  REVIEWED: 'DECISION',
  ASSIGNED: 'DECISION',
  REASSIGNED: 'DECISION',
  UNASSIGNED: 'DECISION',
  OWNER_CHANGED: 'DECISION',
  PRIORITY_CHANGED: 'DECISION',
  SEVERITY_CHANGED: 'DECISION',
  EVIDENCE_ADDED: 'DECISION',
  EVIDENCE_CONTEXT_RECORDED: 'DECISION',
  WATCH_STARTED: 'DECISION',
  WATCH_STOPPED: 'DECISION',
  NOTE_ADDED: 'DECISION',
  AWAITING_RESPONSE: 'DECISION',
  RESPONSE_RECEIVED: 'DECISION',
  ESCALATED: 'DECISION',
  OUTCOME_RECORDED: 'DECISION',
  RESOLVED: 'DECISION',
  DISMISSED: 'DECISION',
  INVESTIGATION_AUTHORIZED: 'DECISION',
  PARTICIPANT_ADDED: 'DECISION',
  PARTICIPANT_CHANGED: 'DECISION',
  PARTICIPANT_RELEASED: 'DECISION',
  MONITORING_STARTED: 'DECISION',
  MONITORING_REVISED: 'DECISION',
  MONITORING_CONCLUDED: 'DECISION',
  // Loop Intelligence Phase C: a person promoted the Case to Work OS work.
  WORK_LINKED: 'WORK',
};

const INTERPRETIVE: readonly ActivityCategory[] = ['SIGNAL', 'FINDING', 'RECOMMENDATION'];

function categoryOf(type: string): ActivityCategory {
  // A row written before a type existed in this build is still real history; it is
  // shown as a decision-log entry rather than dropped or guessed at.
  return CATEGORY[type as ObservationType] ?? 'DECISION';
}

/** A person says what they saw; a machine either records or interprets. */
function epistemicOf(type: string, actorType: string): ActivityEpistemicKind {
  if (actorType === 'HUMAN') return 'HUMAN_REPORTED';
  return INTERPRETIVE.includes(categoryOf(type)) ? 'INTERPRETED' : 'RECORDED';
}

function timeBasisOf(row: OperationalObservation): ActivityOccurredAtBasis {
  if (row.detectionKey) return 'REPORTING_WINDOW';
  if (row.actorType === 'HUMAN') return 'OPERATOR_STATED';
  return 'LOOP_CLOCK';
}

export function observationActivityItem(row: OperationalObservation): ActivityItemV1 {
  // The Case is the subject. It is a Case, never a person: an observation records
  // what the organization did about a situation.
  const subjects: ActivitySubjectRef[] = [{ kind: 'CASE', id: row.priorityId }];
  const participants: ActivitySubjectRef[] = [];
  if (row.actorUserId) participants.push({ kind: 'USER', id: row.actorUserId });
  if (row.assignedToUserId) participants.push({ kind: 'USER', id: row.assignedToUserId });
  const stateChange =
    row.previousState !== null || row.newState !== null ? { from: row.previousState, to: row.newState } : null;
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: `${RECORD_TYPE}:${row.id}:${row.sequence}`,
    organizationId: row.organizationId,
    category: categoryOf(row.observationType),
    type: row.observationType,
    authority: {
      domain: 'decision-engine',
      recordType: RECORD_TYPE,
      recordId: row.id,
      sequence: row.sequence,
      href: `/app/admin/cases/${row.priorityId}`,
    },
    time: {
      occurredAt: row.occurredAt.toISOString(),
      occurredAtBasis: timeBasisOf(row),
      recordedAt: row.recordedAt.toISOString(),
      window: null,
    },
    actor: {
      kind: row.actorType === 'HUMAN' ? 'HUMAN' : 'SYSTEM',
      userId: row.actorUserId,
      producer: row.source,
      producerVersion: null,
    },
    subjects,
    participants,
    identity: deriveIdentitySubject(subjects),
    provenance: {
      source: row.source,
      transport: null,
      epistemic: epistemicOf(row.observationType, row.actorType),
      ruleId: row.detectionKey,
      ruleVersion: null,
      evidenceCount: null,
      // The outcome is the authority's own label. Never a score, never a percentage.
      limitations: [],
    },
    display: {
      title: row.observationType.toLowerCase().replace(/_/g, ' '),
      channel: null,
      direction: null,
      stateChange,
      semanticStatus: row.outcome,
    },
    access: { requires: REQUIRES, workspace: 'ADMIN' },
    // `note`, `reason` and `evidence` stay in the source: an operator's words about a
    // situation are content, read on the Case page under its own guard.
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: Boolean(row.note || row.reason), contentInline: false },
  };
}

export class ObservationActivityAdapter implements ActivityAdapter {
  readonly domain = 'decision-engine';
  readonly workspace = 'ADMIN';
  readonly categories: readonly ActivityCategory[] = ['SIGNAL', 'FINDING', 'RECOMMENDATION', 'DECISION', 'COMMUNICATION'];

  constructor(private readonly prisma: PrismaClient) {}

  supports(subject: ActivitySubject): boolean {
    // One Case at a time. There is no organization-wide index on
    // (organizationId, occurredAt) for this table, and a read that cannot use an
    // index does not belong in a feed -- see the A2 performance note.
    return subject.kind === 'CASE';
  }

  requiresFor(_subject: ActivitySubject): readonly ActivityRequirement[] {
    return REQUIRES;
  }

  async page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage> {
    if (request.subject.kind !== 'CASE') return EMPTY_PAGE;
    const categories = filteredCategories(request.filter, this.categories, activityFilterIncludes);
    if (categories.length === 0) return EMPTY_PAGE;
    const types = (Object.keys(CATEGORY) as ObservationType[]).filter((t) => categories.includes(CATEGORY[t]));
    if (types.length === 0) return EMPTY_PAGE;

    // (organizationId, priorityId, …) is the selective prefix of this table's own
    // index, so one Case's log is reached directly. Ordering is the contract's --
    // occurrence, not sequence -- because an operator can record today something
    // that happened last week, and the log's order is not the world's.
    // A private situation's log belongs to its one owner; the activity surface is the organization's.
    if (!(await this.prisma.operationalPriority.findFirst({ where: { id: request.subject.priorityId, organizationId: request.organizationId, ...CASE_ORGANIZATION_WHERE }, select: { id: true } }))) return EMPTY_PAGE;
    const rows = await this.prisma.operationalObservation.findMany({
      where: {
        organizationId: request.organizationId,
        priorityId: request.subject.priorityId,
        observationType: { in: types },
        ...keysetWhere('occurredAt', RECORD_TYPE, request.cursor, idFromKeyRest),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: request.limit + 1,
    });

    const { items } = admit(rows.map(observationActivityItem), request.cursor);
    return { items, rowsRead: rows.length, suppressed: 0, limitations: [] };
  }
}

/**
 * This source's key is `<recordType>:<id>:<sequence>`, so the record id is what sits
 * before the last colon. Without this the keyset would compare a row's id against
 * `<id>:<sequence>` and hand back the row it had just returned.
 */
function idFromKeyRest(rest: string): string {
  const cut = rest.lastIndexOf(':');
  return cut === -1 ? rest : rest.slice(0, cut);
}
