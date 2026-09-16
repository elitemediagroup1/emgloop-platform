// Work execution as Activity -- the Work OS adapter.
//
// Slice A2 completed by the Work IAM slice. `WorkStageEvent` is the authority for
// what happened to a work item: a state change, a due time set or moved, a
// dependency declared or resolved, a note.
//
// WHY THIS ARRIVED LATE. A2 could not ship it. `activity.v1` requires every item to
// state a `resource:action` a server re-checks, and Work OS was guarded by workspace
// role alone -- it had no resource to name. The honest options were to invent one
// (the shortcut the contract exists to prevent) or to give Work a real IAM resource.
// The resource is now real, and it means the capability the ADMIN work tree already
// carries: seeing the organization's work as a whole. So items here require
// `work:view` AND the ADMIN workspace -- exactly what /app/admin/work requires
// today, which is why nobody can see anything here they could not already open.
//
// A WORK ITEM IS NOT A PERSON. Its subject is the work, and the people on it are
// Users -- accountability, not Party participation. No identity state is ever
// derived from a work item, so every item is NOT_APPLICABLE / NONE.
//
// THE GAP THIS INHERITS. Completion, handoff and assignment do not write
// WorkStageEvent consistently (universal-activity.md section 6, a slice A3 fix). So
// this lane is honest but incomplete, and the page says so through the source's
// limitation rather than by quietly looking empty.

import type { PrismaClient, WorkStageEvent } from '@prisma/client';
import {
  ACTIVITY_CONTRACT_VERSION,
  activityFilterIncludes,
  deriveIdentitySubject,
  type ActivityCategory,
  type ActivityItemV1,
  type ActivitySubjectRef,
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

const RECORD_TYPE = 'work-stage-event';
const REQUIRES: readonly ActivityRequirement[] = [{ resource: 'work', action: 'view' }];
const LIMITATION_COVERAGE =
  'work transitions are not logged consistently yet, so this history can be incomplete';

export function workActivityItem(row: WorkStageEvent): ActivityItemV1 {
  // The work item is the subject. The people are Users: accountability, never a Party.
  const subjects: ActivitySubjectRef[] = [{ kind: 'WORK_ITEM', id: row.workInstanceId }];
  const participants: ActivitySubjectRef[] = row.actorUserId ? [{ kind: 'USER', id: row.actorUserId }] : [];
  const stateChange =
    row.fromStatus !== null || row.toStatus !== null ? { from: row.fromStatus, to: row.toStatus } : null;
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: `${RECORD_TYPE}:${row.id}:${row.sequence}`,
    organizationId: row.organizationId,
    category: 'WORK',
    // WORK_EVENT_TYPES, the source's own closed vocabulary.
    type: row.eventType,
    authority: {
      domain: 'work-os',
      recordType: RECORD_TYPE,
      recordId: row.id,
      sequence: row.sequence,
      href: `/app/admin/work/${row.workInstanceId}`,
    },
    time: {
      occurredAt: row.occurredAt.toISOString(),
      // The log stamps occurrence with the Loop clock as the act is recorded; it
      // carries no separate provider or operator time to prefer.
      occurredAtBasis: 'LOOP_CLOCK',
      recordedAt: row.createdAt.toISOString(),
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
      epistemic: row.actorType === 'HUMAN' ? 'HUMAN_REPORTED' : 'RECORDED',
      ruleId: null,
      ruleVersion: null,
      evidenceCount: null,
      limitations: [LIMITATION_COVERAGE],
    },
    display: {
      title: row.eventType.toLowerCase().replace(/_/g, ' '),
      channel: null,
      direction: null,
      stateChange,
      // A wait reason is a CODE from a closed vocabulary, never prose: whether the
      // accountability clock pauses must not be decided by wording.
      semanticStatus: row.waitReason,
    },
    access: { requires: REQUIRES, workspace: 'ADMIN' },
    // `note` and `waitSubject` are the operator's own words and stay in the source.
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: Boolean(row.note || row.waitSubject), contentInline: false },
  };
}

export class WorkActivityAdapter implements ActivityAdapter {
  readonly domain = 'work-os';
  readonly workspace = 'ADMIN';
  readonly categories: readonly ActivityCategory[] = ['WORK'];

  constructor(private readonly prisma: PrismaClient) {}

  supports(subject: ActivitySubject): boolean {
    // One work item at a time. (organizationId, workStageId, sequence) reaches a
    // stage's log directly; there is no organization-wide index over occurrence, and
    // a read that cannot use an index does not belong in a feed.
    return subject.kind === 'WORK_ITEM';
  }

  requiresFor(_subject: ActivitySubject): readonly ActivityRequirement[] {
    return REQUIRES;
  }

  async page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage> {
    if (request.subject.kind !== 'WORK_ITEM') return EMPTY_PAGE;
    if (filteredCategories(request.filter, this.categories, activityFilterIncludes).length === 0) return EMPTY_PAGE;

    const rows = await this.prisma.workStageEvent.findMany({
      where: {
        organizationId: request.organizationId,
        workInstanceId: request.subject.workInstanceId,
        ...keysetWhere('occurredAt', RECORD_TYPE, request.cursor, idFromKeyRest),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: request.limit + 1,
    });

    const { items } = admit(rows.map(workActivityItem), request.cursor);
    return { items, rowsRead: rows.length, suppressed: 0, limitations: [LIMITATION_COVERAGE] };
  }
}

/** This source's key is `<recordType>:<id>:<sequence>`; the record id ends at the last colon. */
function idFromKeyRest(rest: string): string {
  const cut = rest.lastIndexOf(':');
  return cut === -1 ? rest : rest.slice(0, cut);
}
