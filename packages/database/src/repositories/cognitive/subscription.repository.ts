// StateChangeSubscriptionRepository — which internal service reacts to which
// state changes. Increment 1 supports INTERNAL_HANDLER delivery only; no
// outbound webhooks. The publisher (Increment 3) matches outbox rows against
// ACTIVE subscriptions by domain and stateKey pattern.

import type {
  PrismaClient,
  StateChangeSubscription,
  SubscriberType,
  SubscriptionDeliveryMode,
  ActiveStateDomain,
  DataPurpose,
} from '@prisma/client';

export interface CreateSubscriptionInput {
  subscriberType: SubscriberType;
  subscriberKey: string;
  endpointOrHandler: string;
  domain?: ActiveStateDomain | null;
  stateKeyPattern?: string | null;
  eventTypes?: string[];
  requiredPurposes?: DataPurpose[];
  minimumConfidence?: number | null;
  deliveryMode?: SubscriptionDeliveryMode;
}

export class StateChangeSubscriptionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(organizationId: string, input: CreateSubscriptionInput): Promise<StateChangeSubscription> {
    // Increment 1 guardrail: internal delivery only. Outbound endpoints are a
    // later phase; refuse to persist a subscription that implies one.
    if (input.deliveryMode && input.deliveryMode !== 'INTERNAL_SYNC' && input.deliveryMode !== 'INTERNAL_ASYNC') {
      throw new Error('Only INTERNAL delivery is supported in this phase');
    }
    return this.prisma.stateChangeSubscription.create({
      data: {
        organizationId,
        subscriberType: input.subscriberType,
        subscriberKey: input.subscriberKey,
        endpointOrHandler: input.endpointOrHandler,
        domain: input.domain ?? null,
        stateKeyPattern: input.stateKeyPattern ?? null,
        eventTypes: input.eventTypes ?? [],
        requiredPurposes: input.requiredPurposes ?? [],
        minimumConfidence: input.minimumConfidence ?? null,
        deliveryMode: input.deliveryMode ?? 'INTERNAL_SYNC',
        status: 'ACTIVE',
      },
    });
  }

  async setStatus(
    organizationId: string,
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
  ): Promise<StateChangeSubscription | null> {
    const found = await this.prisma.stateChangeSubscription.findFirst({
      where: { id, organizationId },
    });
    if (!found) return null;
    return this.prisma.stateChangeSubscription.update({
      where: { id: found.id },
      data: { status },
    });
  }

  /**
   * ACTIVE subscriptions whose domain filter matches (or is null = all) and
   * whose stateKeyPattern the given stateKey satisfies. Pattern matching is a
   * simple prefix/glob on '*': null pattern matches all, an exact string
   * matches equality, a trailing '*' matches by prefix.
   */
  async findMatching(
    organizationId: string,
    change: { domain: ActiveStateDomain; stateKey: string },
  ): Promise<StateChangeSubscription[]> {
    const candidates = await this.prisma.stateChangeSubscription.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        OR: [{ domain: null }, { domain: change.domain }],
      },
    });
    return candidates.filter((s) => stateKeyMatches(s.stateKeyPattern, change.stateKey));
  }

  list(organizationId: string): Promise<StateChangeSubscription[]> {
    return this.prisma.stateChangeSubscription.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }
}

export function stateKeyMatches(pattern: string | null, stateKey: string): boolean {
  if (!pattern) return true;
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return stateKey.startsWith(pattern.slice(0, -1));
  return pattern === stateKey;
}
