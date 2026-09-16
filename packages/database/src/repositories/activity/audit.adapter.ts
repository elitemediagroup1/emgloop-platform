// Governance acts as Activity -- the audit adapter.
//
// Slice A2. `AuditLog` is the authority for what an authorized person did: who
// changed a record, who established a Party, who linked an Intake Record. It is the
// one source `activity.v1` treats as category AUDIT.
//
// IT REQUIRES `audit:view`, ALWAYS. Loop Home and the Work surface read audit rows
// today without it (§6). This adapter does not inherit that: every item it produces
// demands the audit grant, so composing an Intake Record's timeline can never become
// a way around it. An audit row names actors, before/after values and IP addresses --
// it is a governance record, not general activity.
//
// NO BEFORE/AFTER VALUES ARE PROJECTED. `before`, `after`, `ip` and `userAgent` stay
// in the source. What crosses is that something changed, by whom, and when.

import type { PrismaClient, AuditLog } from '@prisma/client';
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

const RECORD_TYPE = 'audit-log';
const REQUIRES: readonly ActivityRequirement[] = [{ resource: 'audit', action: 'view' }];

const ACTOR: Record<string, ActivityActorKind> = {
  HUMAN_AGENT: 'HUMAN',
  AI_AGENT: 'AI_EMPLOYEE',
  SYSTEM: 'SYSTEM',
  CUSTOMER: 'UNKNOWN',
};

export function auditActivityItem(row: AuditLog): ActivityItemV1 {
  const subjects: ActivitySubjectRef[] = [];
  // An audit row about a Customer is about an INTAKE RECORD. It is never promoted to
  // a Person: the entity it names is the legacy row, whatever that row was linked to.
  if (row.entityType === 'customer' && row.entityId) subjects.push({ kind: 'INTAKE_RECORD', customerId: row.entityId });
  const participants: ActivitySubjectRef[] = row.userId ? [{ kind: 'USER', id: row.userId }] : [];
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: `${RECORD_TYPE}:${row.id}`,
    organizationId: row.organizationId,
    category: 'AUDIT',
    // The audit vocabulary as written, e.g. 'customer.updated', 'party.established'.
    type: row.action,
    authority: { domain: 'audit', recordType: RECORD_TYPE, recordId: row.id, sequence: null, href: '/crm/audit' },
    time: {
      // An audit row is written in the same act it records, so the Loop clock is the
      // occurrence. The table stores no separate occurrence column to prefer.
      occurredAt: row.createdAt.toISOString(),
      occurredAtBasis: 'LOOP_CLOCK',
      recordedAt: row.createdAt.toISOString(),
      window: null,
    },
    actor: { kind: ACTOR[row.actorType] ?? 'UNKNOWN', userId: row.userId, producer: null, producerVersion: null },
    subjects,
    participants,
    identity: deriveIdentitySubject(subjects),
    provenance: {
      source: 'audit',
      transport: null,
      epistemic: 'RECORDED',
      ruleId: null,
      ruleVersion: null,
      evidenceCount: null,
      limitations: [],
    },
    display: {
      title: row.action,
      channel: null,
      direction: null,
      // Before and after are the governance record's own; only their existence crosses.
      stateChange: row.before || row.after ? { from: null, to: null } : null,
      semanticStatus: null,
    },
    access: { requires: REQUIRES, workspace: null },
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: true, contentInline: false },
  };
}

export class AuditActivityAdapter implements ActivityAdapter {
  readonly domain = 'audit';
  readonly workspace = null;
  readonly categories: readonly ActivityCategory[] = ['AUDIT'];

  constructor(private readonly prisma: PrismaClient) {}

  supports(subject: ActivitySubject): boolean {
    return subject.kind === 'ORGANIZATION' || subject.kind === 'INTAKE_RECORD';
  }

  requiresFor(_subject: ActivitySubject): readonly ActivityRequirement[] {
    return REQUIRES;
  }

  async page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage> {
    if (!this.supports(request.subject)) return EMPTY_PAGE;
    if (filteredCategories(request.filter, this.categories, activityFilterIncludes).length === 0) return EMPTY_PAGE;

    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId: request.organizationId,
        ...(request.subject.kind === 'INTAKE_RECORD'
          ? { entityType: 'customer', entityId: request.subject.customerId }
          : {}),
        ...keysetWhere('createdAt', RECORD_TYPE, request.cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: request.limit + 1,
    });

    const { items } = admit(rows.map(auditActivityItem), request.cursor);
    return {
      items,
      rowsRead: rows.length,
      suppressed: 0,
      limitations:
        request.subject.kind === 'INTAKE_RECORD'
          ? ['the (entityType, entityId) index this read uses is not organization-prefixed; the organization filter is applied in the query']
          : [],
    };
  }
}
