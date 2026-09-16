// Messages as Activity -- the conversation adapter.
//
// Slice A2. `Message` is the authority for what was said in a thread. Its body never
// crosses into an item: `contentInline` is false for every item in this contract, and
// the body is read on the inbox surface under that surface's own guard.
//
// SENT-AT IS INSERT TIME. The column is `@default(now())`, and no path supplies a
// provider timestamp (§2). So the basis is the Loop clock and the item says so,
// rather than claiming the provider reported it.
//
// A THREAD BELONGS TO AN INTAKE RECORD, NOT A PERSON. `Conversation.customerId`
// points at a legacy Customer row, which is an Intake Record. The subject is reported
// as such, with the same INTAKE_LINK_CONTEXT basis every other attached fact gets.

import type { PrismaClient, Message } from '@prisma/client';
import {
  ACTIVITY_CONTRACT_VERSION,
  activityFilterIncludes,
  deriveIdentitySubject,
  type ActivityActorKind,
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

const RECORD_TYPE = 'message';
const REQUIRES: readonly ActivityRequirement[] = [{ resource: 'customers', action: 'view' }];
const LIMITATION_TIME = 'the thread records no send time from the provider; this is when Loop stored the message';

const ACTOR: Record<string, ActivityActorKind> = {
  HUMAN_AGENT: 'HUMAN',
  AI_AGENT: 'AI_EMPLOYEE',
  SYSTEM: 'SYSTEM',
  CUSTOMER: 'UNKNOWN',
};

export function messageActivityItem(row: Message, customerId: string | null): ActivityItemV1 {
  const subjects: ActivitySubjectRef[] = [];
  if (customerId) subjects.push({ kind: 'INTAKE_RECORD', customerId });
  subjects.push({ kind: 'CONVERSATION', id: row.conversationId });
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: `${RECORD_TYPE}:${row.id}`,
    organizationId: row.organizationId,
    category: 'COMMUNICATION',
    type: row.type,
    authority: { domain: 'conversations', recordType: RECORD_TYPE, recordId: row.id, sequence: null, href: '/crm/inbox' },
    time: {
      occurredAt: row.sentAt.toISOString(),
      occurredAtBasis: 'LOOP_CLOCK',
      recordedAt: row.createdAt.toISOString(),
      window: null,
    },
    actor: {
      kind: ACTOR[row.actorType] ?? 'UNKNOWN',
      // `actorId` is a userId, a customerId or an agent id depending on actorType, so
      // it is only reported as a user when the source says it is one.
      userId: row.actorType === 'HUMAN_AGENT' ? row.actorId : null,
      producer: row.provider,
      producerVersion: null,
    },
    subjects,
    participants: [],
    identity: deriveIdentitySubject(subjects),
    provenance: {
      source: row.provider ?? 'conversations',
      transport: null,
      epistemic: 'RECORDED',
      ruleId: null,
      ruleVersion: null,
      evidenceCount: null,
      limitations: [LIMITATION_TIME],
    },
    display: {
      // The type and nothing else. A subject line or body excerpt is content.
      title: `message (${row.type.toLowerCase()})`,
      channel: null,
      direction: null,
      stateChange: null,
      semanticStatus: null,
    },
    access: { requires: REQUIRES, workspace: null },
    sensitivity: { class: 'COMMUNICATION_CONTENT', rawValuesInSource: true, contentInline: false },
  };
}

export class MessageActivityAdapter implements ActivityAdapter {
  readonly domain = 'conversations';
  readonly workspace = null;
  readonly categories: readonly ActivityCategory[] = ['COMMUNICATION'];

  constructor(private readonly prisma: PrismaClient) {}

  supports(subject: ActivitySubject): boolean {
    // Only an Intake Record's threads. There is no (organizationId, sentAt) index to
    // page an organization-wide message feed from, and an unbounded scan is not a
    // feed -- see the A2 performance note.
    return subject.kind === 'INTAKE_RECORD';
  }

  requiresFor(_subject: ActivitySubject): readonly ActivityRequirement[] {
    return REQUIRES;
  }

  async page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage> {
    if (request.subject.kind !== 'INTAKE_RECORD') return EMPTY_PAGE;
    if (filteredCategories(request.filter, this.categories, activityFilterIncludes).length === 0) return EMPTY_PAGE;
    const customerId = request.subject.customerId;

    // Two bounded reads, never one per thread: the Intake Record's conversations,
    // then that set's messages. (customerId) and (conversationId, sentAt) are both
    // indexed.
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId: request.organizationId, customerId },
      select: { id: true },
      take: CONVERSATION_FANOUT_LIMIT,
    });
    if (conversations.length === 0) return { ...EMPTY_PAGE, rowsRead: 0 };

    const rows = await this.prisma.message.findMany({
      where: {
        organizationId: request.organizationId,
        conversationId: { in: conversations.map((c) => c.id) },
        ...keysetWhere('sentAt', RECORD_TYPE, request.cursor),
      },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: request.limit + 1,
    });

    const { items } = admit(rows.map((row) => messageActivityItem(row, customerId)), request.cursor);
    return {
      items,
      rowsRead: conversations.length + rows.length,
      suppressed: 0,
      limitations:
        conversations.length === CONVERSATION_FANOUT_LIMIT
          ? [`only the first ${CONVERSATION_FANOUT_LIMIT} threads of this Intake Record are read`]
          : [],
    };
  }
}

/** A bound on the thread fan-out, so one Intake Record can never widen the read without limit. */
export const CONVERSATION_FANOUT_LIMIT = 100;
