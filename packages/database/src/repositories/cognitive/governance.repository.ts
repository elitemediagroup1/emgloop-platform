// DataGovernancePolicyRepository — governed purpose/consent/retention policy.
//
// Policies declare, per entity/event/predicate + sensitivity, which purposes are
// allowed vs denied, whether aggregation / AI reasoning / external disclosure is
// permitted, retention, and whether consent or human approval is required.
//
// This repository only PERSISTS and RETRIEVES policy. Evaluation lives in the
// GovernanceEvaluator (Increment 2), which is deny-by-default. `findApplicable`
// returns the candidate ACTIVE policies for a given shape so the evaluator can
// combine them; it never decides on its own.

import type {
  PrismaClient,
  DataGovernancePolicy,
  CognitiveEntityType,
  MemoryEventType,
  DataSensitivity,
  DataPurpose,
  GovernancePolicyStatus,
  Prisma,
} from '@prisma/client';

export interface CreatePolicyInput {
  name: string;
  description?: string | null;
  appliesToEntityType?: CognitiveEntityType | null;
  appliesToEventType?: MemoryEventType | null;
  appliesToAssertionPredicate?: string | null;
  sensitivity?: DataSensitivity | null;
  allowedPurposes?: DataPurpose[];
  deniedPurposes?: DataPurpose[];
  allowedChannels?: string[];
  aggregationAllowed?: boolean;
  aiReasoningAllowed?: boolean;
  externalDisclosureAllowed?: boolean;
  retentionDays?: number | null;
  requiresConsent?: boolean;
  requiresHumanApproval?: boolean;
  status?: GovernancePolicyStatus;
  version?: number;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
}

export class DataGovernancePolicyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(organizationId: string, input: CreatePolicyInput): Promise<DataGovernancePolicy> {
    return this.prisma.dataGovernancePolicy.create({
      data: {
        organizationId,
        name: input.name,
        description: input.description ?? null,
        appliesToEntityType: input.appliesToEntityType ?? null,
        appliesToEventType: input.appliesToEventType ?? null,
        appliesToAssertionPredicate: input.appliesToAssertionPredicate ?? null,
        sensitivity: input.sensitivity ?? null,
        allowedPurposes: input.allowedPurposes ?? [],
        deniedPurposes: input.deniedPurposes ?? [],
        allowedChannels: input.allowedChannels ?? [],
        aggregationAllowed: input.aggregationAllowed ?? false,
        aiReasoningAllowed: input.aiReasoningAllowed ?? false,
        externalDisclosureAllowed: input.externalDisclosureAllowed ?? false,
        retentionDays: input.retentionDays ?? null,
        requiresConsent: input.requiresConsent ?? false,
        requiresHumanApproval: input.requiresHumanApproval ?? false,
        status: input.status ?? 'DRAFT',
        version: input.version ?? 1,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        effectiveTo: input.effectiveTo ?? null,
      },
    });
  }

  findById(organizationId: string, id: string): Promise<DataGovernancePolicy | null> {
    return this.prisma.dataGovernancePolicy.findFirst({ where: { id, organizationId } });
  }

  async setStatus(
    organizationId: string,
    id: string,
    status: GovernancePolicyStatus,
  ): Promise<DataGovernancePolicy | null> {
    const found = await this.findById(organizationId, id);
    if (!found) return null;
    return this.prisma.dataGovernancePolicy.update({
      where: { id: found.id },
      data: { status },
    });
  }

  /**
   * Candidate ACTIVE, currently-effective policies for a given shape. Matches
   * either a policy that targets the exact entity/event/predicate OR a general
   * policy that leaves that dimension null (applies to all). The evaluator
   * combines these; this method never grants or denies.
   */
  async findApplicable(
    organizationId: string,
    shape: {
      entityType?: CognitiveEntityType | null;
      eventType?: MemoryEventType | null;
      predicate?: string | null;
    },
    now: Date = new Date(),
  ): Promise<DataGovernancePolicy[]> {
    return this.prisma.dataGovernancePolicy.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        AND: [
          {
            OR: [
              { appliesToEntityType: null },
              ...(shape.entityType ? [{ appliesToEntityType: shape.entityType }] : []),
            ],
          },
          {
            OR: [
              { appliesToEventType: null },
              ...(shape.eventType ? [{ appliesToEventType: shape.eventType }] : []),
            ],
          },
          {
            OR: [
              { appliesToAssertionPredicate: null },
              ...(shape.predicate ? [{ appliesToAssertionPredicate: shape.predicate }] : []),
            ],
          },
        ],
      },
      orderBy: { version: 'desc' },
    });
  }

  listActive(organizationId: string): Promise<DataGovernancePolicy[]> {
    return this.prisma.dataGovernancePolicy.findMany({
      where: { organizationId, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
