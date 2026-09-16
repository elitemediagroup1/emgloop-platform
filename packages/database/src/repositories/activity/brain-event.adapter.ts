// Brain work as Activity -- the Brain events adapter. Slice B4 (foundation only).
//
// `brain_events` is the authority for what Brain execution did: a job was accepted, was
// promoted, stopped to ask somebody, succeeded, failed or was cancelled. An item here
// says that, who caused it, and -- for a success -- which owners now hold the results.
//
// ACTIVITY NEVER OWNS A BRAIN RESULT. An item carries no summary, claim or model text,
// and its links point at the job and at the owners' own records. The result is read from
// its owner, under the owner's guard, or not at all.
//
// THE TASK'S OWN GUARD. A Brain event is visible to somebody who holds the permissions
// the job's task requires (the same ones the Brain API checks before running it). An
// event for a task this deployment does not know is not shown. The organization-wide lane
// requires every permission any Brain task requires, so an unauthorized viewer costs zero
// queries.
//
// NOT REGISTERED YET. The table does not exist in production until the B4 migration is
// deployed, so `ActivityReadModelRepository` does not compose this adapter in B4; doing
// so before the migration would break every organization-wide Activity read. Registering
// it is a B5 step, after deployment. A test holds this.
//
// WORK, NOT PEOPLE. The subject is Brain work in the organization; no identity state is
// derived from it, so every item is NOT_APPLICABLE / NONE.

import type { PrismaClient } from '@prisma/client';
import {
  ACTIVITY_CONTRACT_VERSION,
  AI_TASKS,
  activityFilterIncludes,
  deriveIdentitySubject,
  type ActivityCategory,
  type ActivityItemV1,
} from '@emgloop/shared';

import type { Resource } from '../iam.repository';
import { brainEventRecordOf, type BrainEventRecord } from '../brain/brain-command.repository';
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

export const BRAIN_EVENT_RECORD_TYPE = 'brain-event';
const DOMAIN = 'brain-execution';

const TITLES: Readonly<Record<string, string>> = {
  'brain.job.accepted': 'Brain work started',
  'brain.job.promoted': 'Brain work continues in the background',
  'brain.job.waiting_for_user': 'Brain is waiting for an answer',
  'brain.job.succeeded': 'Brain work finished',
  'brain.job.failed': 'Brain work did not finish',
  'brain.job.cancelled': 'Brain work was stopped',
};

const STATE_AFTER: Readonly<Record<string, string | null>> = {
  'brain.job.accepted': 'ACCEPTED',
  'brain.job.promoted': null,
  'brain.job.waiting_for_user': 'WAITING_FOR_USER',
  'brain.job.succeeded': 'SUCCEEDED',
  'brain.job.failed': 'FAILED',
  'brain.job.cancelled': 'CANCELLED',
};

/** The permissions each task's surface requires, from the task definitions themselves. */
export function brainTaskRequirements(taskId: string): readonly ActivityRequirement[] | null {
  const task = AI_TASKS.find((t) => t.taskId === taskId);
  if (!task || task.requires.length === 0) return null;
  return task.requires.map((r) => ({ resource: r.resource as Resource, action: 'view' as const }));
}

/** Everything any Brain task requires: what an organization-wide read must hold. */
export function brainOrganizationRequirements(): readonly ActivityRequirement[] {
  const seen = new Map<string, ActivityRequirement>();
  for (const task of AI_TASKS) {
    for (const r of task.requires) seen.set(`${r.resource}:view`, { resource: r.resource as Resource, action: 'view' });
  }
  return [...seen.values()];
}

export function brainEventActivityItem(record: BrainEventRecord): ActivityItemV1 | null {
  const requires = brainTaskRequirements(record.event.taskId);
  if (!requires) return null;
  const e = record.event;
  const actor = e.actor;
  const to = STATE_AFTER[e.name];
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: `${BRAIN_EVENT_RECORD_TYPE}:${record.eventId}`,
    organizationId: e.organizationId,
    category: 'STATE_CHANGE',
    type: e.name,
    authority: {
      domain: DOMAIN,
      recordType: BRAIN_EVENT_RECORD_TYPE,
      recordId: record.eventId,
      sequence: null,
      // No Brain page exists yet; the owners' own pages are where results are read.
      href: null,
    },
    time: {
      occurredAt: e.occurredAt,
      occurredAtBasis: 'LOOP_CLOCK',
      recordedAt: record.recordedAt.toISOString(),
      window: null,
    },
    actor: {
      kind: actor.kind === 'HUMAN' ? 'HUMAN' : 'SYSTEM',
      userId: actor.kind === 'HUMAN' && actor.userId ? actor.userId : null,
      producer: actor.kind === 'POLICY' ? `policy:${actor.policy}` : DOMAIN,
      producerVersion: null,
    },
    subjects: [],
    participants: actor.kind === 'HUMAN' && actor.userId ? [{ kind: 'USER', id: actor.userId }] : [],
    identity: deriveIdentitySubject([]),
    provenance: {
      source: DOMAIN,
      transport: null,
      // That the job changed state is recorded fact. What the work concluded is not
      // here at all; it is its owner's to show.
      epistemic: 'RECORDED',
      ruleId: null,
      ruleVersion: null,
      evidenceCount: e.resultRefs.length > 0 ? e.resultRefs.length : null,
      limitations: [],
    },
    display: {
      title: TITLES[e.name] ?? 'Brain work changed',
      channel: null,
      direction: null,
      stateChange: to ? { from: null, to } : null,
      // The kind of result the work produces, never the result.
      semanticStatus: e.resultType,
    },
    access: { requires, workspace: null },
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: false, contentInline: false },
  };
}

export class BrainEventActivityAdapter implements ActivityAdapter {
  readonly domain = DOMAIN;
  readonly workspace = null;
  readonly categories: readonly ActivityCategory[] = ['STATE_CHANGE'];

  constructor(private readonly prisma: PrismaClient) {}

  supports(subject: ActivitySubject): boolean {
    // Organization-wide only in B4: (organizationId, occurredAt, id) is the index.
    return subject.kind === 'ORGANIZATION';
  }

  requiresFor(_subject: ActivitySubject): readonly ActivityRequirement[] {
    return brainOrganizationRequirements();
  }

  async page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage> {
    if (request.subject.kind !== 'ORGANIZATION') return EMPTY_PAGE;
    if (filteredCategories(request.filter, this.categories, activityFilterIncludes).length === 0) return EMPTY_PAGE;
    const rows = await this.prisma.brainEvent.findMany({
      where: { organizationId: request.organizationId, ...keysetWhere('occurredAt', BRAIN_EVENT_RECORD_TYPE, request.cursor) },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: request.limit + 1,
    });
    const built: ActivityItemV1[] = [];
    let unknownTask = 0;
    for (const row of rows) {
      const item = brainEventActivityItem(brainEventRecordOf(row));
      if (item) built.push(item);
      else unknownTask += 1;
    }
    const { items, refused } = admit(built, request.cursor);
    return {
      items,
      rowsRead: rows.length,
      suppressed: refused.length + unknownTask,
      limitations: unknownTask > 0 ? ['some Brain work belongs to a task this deployment does not know, and is not shown'] : [],
    };
  }
}
