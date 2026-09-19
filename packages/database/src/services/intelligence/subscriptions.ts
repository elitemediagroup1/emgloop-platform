// The outbox subscriptions organization intelligence needs, declared once per organization.
//
// The publisher delivers an event only to ACTIVE subscription ROWS in that event's organization --
// a subscription is a per-organization opt-in that can be switched off (INACTIVE) without a deploy.
// These are the rows the intelligence reviews need. Declaring them is idempotent: an existing row
// with the same key is left exactly as it is, including a person's decision to switch it off.
import type { PrismaClient, ActiveStateDomain } from '@prisma/client';

export interface IntelligenceSubscriptionDefinition {
  readonly subscriberKey: string;
  readonly endpointOrHandler: string;
  readonly domain: ActiveStateDomain;
  readonly stateKeyPattern: string;
  readonly purpose: string;
}

export const INTELLIGENCE_SUBSCRIPTIONS: readonly IntelligenceSubscriptionDefinition[] = Object.freeze([
  {
    subscriberKey: 'creator-onboarding-review:relationships',
    endpointOrHandler: 'creator-onboarding-review',
    domain: 'RELATIONSHIP',
    stateKeyPattern: 'relationship.*',
    purpose: 'A TALENT_REPRESENTATION Relationship becoming ACTIVE (EMG now represents a creator).',
  },
  {
    subscriberKey: 'creator-onboarding-review:creator-hub',
    endpointOrHandler: 'creator-onboarding-review',
    domain: 'CREATOR',
    stateKeyPattern: 'creator.*',
    purpose: "Creator Hub's CreatorOnboarded event, once that authority exists.",
  },
]);

export interface DeclaredSubscription {
  readonly subscriberKey: string;
  readonly result: 'CREATED' | 'EXISTS' | 'WOULD_CREATE';
  readonly status: string | null;
}

export async function declareIntelligenceSubscriptions(
  prisma: PrismaClient,
  organizationId: string,
  options: { readonly apply: boolean },
): Promise<readonly DeclaredSubscription[]> {
  const out: DeclaredSubscription[] = [];
  for (const def of INTELLIGENCE_SUBSCRIPTIONS) {
    const existing = await prisma.stateChangeSubscription.findFirst({ where: { organizationId, subscriberKey: def.subscriberKey } });
    if (existing) {
      out.push({ subscriberKey: def.subscriberKey, result: 'EXISTS', status: existing.status });
      continue;
    }
    if (!options.apply) {
      out.push({ subscriberKey: def.subscriberKey, result: 'WOULD_CREATE', status: null });
      continue;
    }
    const created = await prisma.stateChangeSubscription.create({
      data: {
        organizationId,
        subscriberType: 'INTERNAL_HANDLER',
        subscriberKey: def.subscriberKey,
        endpointOrHandler: def.endpointOrHandler,
        domain: def.domain,
        stateKeyPattern: def.stateKeyPattern,
        deliveryMode: 'INTERNAL_SYNC',
        required: false,
        status: 'ACTIVE',
      },
    });
    out.push({ subscriberKey: def.subscriberKey, result: 'CREATED', status: created.status });
  }
  return out;
}
