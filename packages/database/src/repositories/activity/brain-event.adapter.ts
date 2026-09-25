// Brain work as Activity -- the Brain events adapter. Slice B4; composed in B5.
//
// `brain_events` is the authority for what Brain execution did: a job was accepted, was
// promoted, stopped to ask somebody, succeeded, failed or was cancelled. An item here
// says that, who caused it, and -- for a success -- which owners now hold the results.
//
// ACTIVITY NEVER OWNS A BRAIN RESULT. An item carries no summary, claim or model text,
// and its links point at the job and at the owners' own records. The result is read from
// its owner, under the owner's guard, or not at all.
//
// THE TASK'S OWN GUARD, IN THE WORKSPACE ITS SURFACES LIVE IN. A Brain event is visible
// to somebody who holds the permissions the job's task requires (the same ones the Brain
// API checks before running it), inside the ADMIN workspace where every Brain surface is
// today (the Brain module and the Case pages). An event for a task this deployment does
// not know is not shown. The organization-wide lane requires every permission any Brain
// task requires, so an unauthorized viewer costs zero queries.
//
// COMPOSED ONCE ITS TABLE EXISTED. B4 built this adapter but left it out of the live
// feed until migration 36 was deployed (run 35160530756, 2026-09-16); B5 composes it.
//
// TWO LANES. The organization-wide lane shows every Brain event the viewer may see; the
// Case lane shows the events of Brain work about that Case. Other subjects follow when
// their records carry Activity.
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

/** What a person calls each kind of result. Never a provider, a model or an attempt. */
const NOUNS: Readonly<Record<string, string>> = {
  ANSWER: 'answer',
  ANALYSIS: 'analysis',
  FINDING: 'finding',
  RECOMMENDATION: 'recommendation',
  DRAFT: 'draft',
  PROPOSED_ACTION: 'proposed action',
};

/** "Brain analysis started", "Brain is waiting for clarification", ... */
export function brainEventTitle(name: string, resultType: string): string {
  const noun = NOUNS[resultType] ?? 'work';
  switch (name) {
    case 'brain.job.accepted':
      return `Brain ${noun} started`;
    case 'brain.job.promoted':
      return `Brain ${noun} continues in the background`;
    case 'brain.job.waiting_for_user':
      return 'Brain is waiting for clarification';
    case 'brain.job.succeeded':
      return `Brain ${noun} completed`;
    case 'brain.job.failed':
      return `Brain ${noun} failed`;
    case 'brain.job.cancelled':
      return `Brain ${noun} cancelled`;
    default:
      return `Brain ${noun} changed`;
  }
}

/** Where Brain work is shown today. A task surfaced elsewhere will name its own workspace. */
const BRAIN_WORKSPACE = 'ADMIN';

/** The lane a Case's own page reads: its surface requires this, on top of each task's own. */
const CASE_LANE_REQUIRES: readonly ActivityRequirement[] = [{ resource: 'commercialIntelligence', action: 'view' }];
/** How many jobs about one subject a Case lane reads events for. */
const MAX_JOBS_PER_SUBJECT = 200;

const STATE_AFTER: Readonly<Record<string, string | null>> = {
  'brain.job.accepted': 'ACCEPTED',
  'brain.job.promoted': null,
  'brain.job.waiting_for_user': 'WAITING_FOR_USER',
  'brain.job.succeeded': 'SUCCEEDED',
  'brain.job.failed': 'FAILED',
  'brain.job.cancelled': 'CANCELLED',
};

/**
 * Tasks whose results belong to ONE EMPLOYEE, and which therefore never appear in an
 * organization's activity feed (GM-3).
 *
 * The activity feed is an organization-level surface: it shows what happened in the business to
 * anybody holding the organization's read authorities. A task owned by `EMPLOYEE_INTELLIGENCE`
 * produces results that are private to one person by construction -- an OWNER does not hold them
 * and an ADMIN does not hold them -- so an event about one must not become an item there, and its
 * read authority must not be folded into what the feed demands.
 *
 * Excluding it in BOTH directions is deliberate: including the requirement would make the
 * organization feed ask for an employee-private permission, and including the ITEM would leak the
 * existence of somebody's private work into a shared surface. Neither is a feed anybody asked for.
 */
const EMPLOYEE_PRIVATE_AUTHORITY = 'EMPLOYEE_INTELLIGENCE';
// Loop Intelligence tasks (domain readings, situations) never run as Brain jobs -- they run through the
// intelligence producer loop and record no Brain events -- so they add nothing to a Brain lane's authority.
const INTELLIGENCE_AUTHORITY = 'LOOP_INTELLIGENCE';
const isOrganizationTask = (task: (typeof AI_TASKS)[number]): boolean =>
  task.resultOwner.authority !== EMPLOYEE_PRIVATE_AUTHORITY && task.resultOwner.authority !== INTELLIGENCE_AUTHORITY;

/** The permissions each task's surface requires, from the task definitions themselves. */
export function brainTaskRequirements(taskId: string): readonly ActivityRequirement[] | null {
  const task = AI_TASKS.find((t) => t.taskId === taskId);
  if (!task || task.requires.length === 0) return null;
  // An employee-private task has no organization-level activity item at all.
  if (!isOrganizationTask(task)) return null;
  return task.requires.map((r) => ({ resource: r.resource as Resource, action: 'view' as const }));
}

/** Everything any organization-level Brain task requires: what an organization-wide read must hold. */
export function brainOrganizationRequirements(): readonly ActivityRequirement[] {
  const seen = new Map<string, ActivityRequirement>();
  for (const task of AI_TASKS.filter(isOrganizationTask)) {
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
      title: brainEventTitle(e.name, e.resultType),
      channel: null,
      direction: null,
      stateChange: to ? { from: null, to } : null,
      // The kind of result the work produces, never the result.
      semanticStatus: e.resultType,
    },
    access: { requires, workspace: BRAIN_WORKSPACE },
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: false, contentInline: false },
  };
}

export class BrainEventActivityAdapter implements ActivityAdapter {
  readonly domain = DOMAIN;
  readonly workspace = BRAIN_WORKSPACE;
  readonly categories: readonly ActivityCategory[] = ['STATE_CHANGE'];

  constructor(private readonly prisma: PrismaClient) {}

  supports(subject: ActivitySubject): boolean {
    // (organizationId, occurredAt, id) serves the organization lane; a Case lane first finds
    // the Case's jobs through (organizationId, resultSubjectType, resultSubjectId, state).
    return subject.kind === 'ORGANIZATION' || subject.kind === 'CASE';
  }

  requiresFor(subject: ActivitySubject): readonly ActivityRequirement[] {
    if (subject.kind === 'CASE') {
      const all = new Map<string, ActivityRequirement>();
      for (const r of [...CASE_LANE_REQUIRES, ...brainOrganizationRequirements()]) all.set(`${r.resource}:${r.action}`, r);
      return [...all.values()];
    }
    return brainOrganizationRequirements();
  }

  async page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage> {
    if (request.subject.kind !== 'ORGANIZATION' && request.subject.kind !== 'CASE') return EMPTY_PAGE;
    if (filteredCategories(request.filter, this.categories, activityFilterIncludes).length === 0) return EMPTY_PAGE;
    let jobScope: Record<string, unknown> = {};
    if (request.subject.kind === 'CASE') {
      const jobs = await this.prisma.brainJob.findMany({
        where: { organizationId: request.organizationId, resultSubjectType: 'CASE', resultSubjectId: request.subject.priorityId },
        select: { id: true },
        orderBy: { acceptedAt: 'desc' },
        take: MAX_JOBS_PER_SUBJECT,
      });
      if (jobs.length === 0) return EMPTY_PAGE;
      jobScope = { jobId: { in: jobs.map((j) => j.id) } };
    }
    const rows = await this.prisma.brainEvent.findMany({
      where: { organizationId: request.organizationId, ...jobScope, ...keysetWhere('occurredAt', BRAIN_EVENT_RECORD_TYPE, request.cursor) },
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
