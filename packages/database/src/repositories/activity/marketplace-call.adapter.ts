// Marketplace calls as Activity -- CallGrid's own execution record.
//
// Slice A2. `MarketplaceCall` is the authority for a routed call: its status, its
// connected duration, and the provider dimensions it was attributed to. Those
// dimensions are EXTERNAL IDS, NOT PARTIES (§2): a buyer id is a marketplace
// counterparty, and turning one into a Person or Company would be identity
// invention by another name. So every item here is NOT_APPLICABLE / NONE.
//
// ONE OCCURRENCE, ONE ITEM. When a call carries `interactionId`, the channel fact
// already records the same occurrence -- and it, unlike this record, knows whether a
// caller identifier was present. Showing both is the defect §6 names (the live feed
// rendering every call twice). So a call backed by an interaction stands down
// whenever the interaction adapter is reading alongside it, and is counted as
// suppressed rather than silently dropped.
//
// ECONOMICS ARE NOT PROJECTED. Revenue, payout, cost and the outcome flags stay in
// the source: they are money, they are read on the marketplace surface under its own
// authority, and `activity.v1` has nowhere honest to put them.

import type { PrismaClient, MarketplaceCall } from '@prisma/client';
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

const RECORD_TYPE = 'marketplace-call';
const REQUIRES: readonly ActivityRequirement[] = [{ resource: 'intelligence', action: 'view' }];
const LIMITATION_CALLER = 'the caller identifier, if any, is held by the linked channel fact, not by this record';

const COUNTERPARTIES: readonly [keyof MarketplaceCall, 'BUYER' | 'VENDOR' | 'SOURCE' | 'CAMPAIGN' | 'DESTINATION'][] = [
  ['buyerExternalId', 'BUYER'],
  ['vendorExternalId', 'VENDOR'],
  ['sourceExternalId', 'SOURCE'],
  ['campaignExternalId', 'CAMPAIGN'],
  ['destinationExternalId', 'DESTINATION'],
];

export function marketplaceCallActivityItem(row: MarketplaceCall): ActivityItemV1 {
  const subjects: ActivitySubjectRef[] = [];
  for (const [field, role] of COUNTERPARTIES) {
    const externalId = row[field];
    if (typeof externalId === 'string' && externalId.trim() !== '') {
      subjects.push({ kind: 'PROVIDER_COUNTERPARTY', role, provider: row.provider, externalId });
    }
  }
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: `${RECORD_TYPE}:${row.id}`,
    organizationId: row.organizationId,
    category: 'FACT',
    // The provider's own disposition vocabulary, kept as the source wrote it.
    type: row.status ?? 'UNKNOWN_STATUS',
    authority: { domain: 'callgrid', recordType: RECORD_TYPE, recordId: row.id, sequence: null, href: null },
    time: {
      // CallGrid refuses an event whose occurrence it cannot establish, so this is
      // always the provider's own time, never the moment the row was written.
      occurredAt: row.sourceOccurredAt.toISOString(),
      occurredAtBasis: 'PROVIDER_REPORTED',
      recordedAt: row.createdAt.toISOString(),
      window: null,
    },
    actor: { kind: 'PROVIDER', userId: null, producer: row.provider, producerVersion: null },
    subjects,
    participants: [],
    identity: deriveIdentitySubject(subjects),
    provenance: {
      source: row.provider,
      // Webhook and recovery sync write the same row shape; which one wrote this is
      // the IntegrationEvent's knowledge, and is not guessed here.
      transport: null,
      epistemic: 'RECORDED',
      ruleId: null,
      ruleVersion: null,
      evidenceCount: null,
      limitations: [LIMITATION_CALLER],
    },
    display: {
      title: `call ${(row.status ?? 'status not reported').toLowerCase()}`,
      channel: 'PHONE',
      direction: 'INBOUND',
      stateChange: null,
      semanticStatus: row.rawStatus,
    },
    access: { requires: REQUIRES, workspace: 'ADMIN' },
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: false, contentInline: false },
  };
}

export class MarketplaceCallActivityAdapter implements ActivityAdapter {
  readonly domain = 'callgrid';
  readonly workspace = 'ADMIN';
  readonly categories: readonly ActivityCategory[] = ['FACT'];

  constructor(private readonly prisma: PrismaClient) {}

  supports(subject: ActivitySubject): boolean {
    // No Intake lane: a marketplace call is attributed to provider dimensions, and
    // attaching one to a legacy Customer row would be the misattachment this
    // architecture exists to stop.
    return subject.kind === 'ORGANIZATION';
  }

  requiresFor(_subject: ActivitySubject): readonly ActivityRequirement[] {
    return REQUIRES;
  }

  async page(request: ActivityAdapterRequest): Promise<ActivityAdapterPage> {
    if (!this.supports(request.subject)) return EMPTY_PAGE;
    if (filteredCategories(request.filter, this.categories, activityFilterIncludes).length === 0) return EMPTY_PAGE;

    const rows = await this.prisma.marketplaceCall.findMany({
      where: {
        organizationId: request.organizationId,
        // Stand down where the channel fact reports the same occurrence.
        ...(request.interactionsIncluded ? { interactionId: null } : {}),
        ...keysetWhere('sourceOccurredAt', RECORD_TYPE, request.cursor),
      },
      orderBy: [{ sourceOccurredAt: 'desc' }, { id: 'desc' }],
      take: request.limit + 1,
    });

    const { items } = admit(rows.map(marketplaceCallActivityItem), request.cursor);
    return {
      items,
      rowsRead: rows.length,
      suppressed: 0,
      limitations: request.interactionsIncluded ? ['calls already reported as a channel fact are shown once, as that fact'] : [],
    };
  }
}
