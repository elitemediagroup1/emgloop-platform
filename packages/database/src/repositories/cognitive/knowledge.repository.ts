// KnowledgeAssertionRepository — governed facts/beliefs (Cognitive Architecture).
//
// WHAT WE KNOW OR BELIEVE, and why. The assertionClass (DECLARED / OBSERVED /
// INFERRED / PREDICTED / ORGANIZATIONAL) is preserved exactly as written and is
// NEVER silently promoted — an inferred belief must not read back as a declared
// fact. Supersession is explicit (status SUPERSEDED + supersededById); nothing
// is hard-deleted.

import type {
  PrismaClient,
  KnowledgeAssertion,
  AssertionClass,
  AssertionStatus,
  CognitiveValueType,
  DataSensitivity,
  DataScope,
  DataPurpose,
  ConsentBasis,
  Prisma,
} from '@prisma/client';

const MAX_TAKE = 200;

export interface CreateAssertionInput {
  subjectIdentityId: string;
  predicate: string;
  value: unknown;
  valueType?: CognitiveValueType;
  assertionClass: AssertionClass;
  status?: AssertionStatus;
  sourceEventId?: string | null;
  sourceIdentityId?: string | null;
  confidence?: number | null;
  sensitivity?: DataSensitivity;
  scope?: DataScope;
  permittedPurposes?: DataPurpose[];
  consentBasis?: ConsentBasis;
  effectiveFrom?: Date;
  expiresAt?: Date | null;
  ownerIdentityId?: string | null;
  ruleVersion?: string | null;
}

export class KnowledgeAssertionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(organizationId: string, input: CreateAssertionInput): Promise<KnowledgeAssertion> {
    return this.prisma.knowledgeAssertion.create({
      data: {
        organizationId,
        subjectIdentityId: input.subjectIdentityId,
        predicate: input.predicate,
        valueType: input.valueType ?? 'STRING',
        value: (input.value ?? {}) as Prisma.InputJsonValue,
        assertionClass: input.assertionClass,
        status: input.status ?? 'ACTIVE',
        sourceEventId: input.sourceEventId ?? null,
        sourceIdentityId: input.sourceIdentityId ?? null,
        confidence: input.confidence ?? null,
        sensitivity: input.sensitivity ?? 'INTERNAL',
        scope: input.scope ?? 'INDIVIDUAL',
        permittedPurposes: input.permittedPurposes ?? [],
        consentBasis: input.consentBasis ?? 'NONE',
        effectiveFrom: input.effectiveFrom ?? new Date(),
        expiresAt: input.expiresAt ?? null,
        ownerIdentityId: input.ownerIdentityId ?? null,
        ruleVersion: input.ruleVersion ?? null,
      },
    });
  }

  findById(organizationId: string, id: string): Promise<KnowledgeAssertion | null> {
    return this.prisma.knowledgeAssertion.findFirst({ where: { id, organizationId } });
  }

  findActiveByPredicate(
    organizationId: string,
    subjectIdentityId: string,
    predicate: string,
  ): Promise<KnowledgeAssertion | null> {
    return this.prisma.knowledgeAssertion.findFirst({
      where: { organizationId, subjectIdentityId, predicate, status: 'ACTIVE' },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  /**
   * Supersede an active assertion with a newly-created one of the same
   * predicate. Both writes happen in one transaction: the old row moves to
   * SUPERSEDED (pointing at the new id), the new row becomes ACTIVE.
   */
  async supersede(
    organizationId: string,
    previousId: string,
    input: CreateAssertionInput,
  ): Promise<KnowledgeAssertion | null> {
    const previous = await this.findById(organizationId, previousId);
    if (!previous) return null;
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.knowledgeAssertion.create({
        data: {
          organizationId,
          subjectIdentityId: input.subjectIdentityId,
          predicate: input.predicate,
          valueType: input.valueType ?? 'STRING',
          value: (input.value ?? {}) as Prisma.InputJsonValue,
          assertionClass: input.assertionClass,
          status: 'ACTIVE',
          sourceEventId: input.sourceEventId ?? null,
          sourceIdentityId: input.sourceIdentityId ?? null,
          confidence: input.confidence ?? null,
          sensitivity: input.sensitivity ?? 'INTERNAL',
          scope: input.scope ?? 'INDIVIDUAL',
          permittedPurposes: input.permittedPurposes ?? [],
          consentBasis: input.consentBasis ?? 'NONE',
          effectiveFrom: input.effectiveFrom ?? new Date(),
          expiresAt: input.expiresAt ?? null,
          ownerIdentityId: input.ownerIdentityId ?? null,
          ruleVersion: input.ruleVersion ?? null,
        },
      });
      await tx.knowledgeAssertion.update({
        where: { id: previous.id },
        data: { status: 'SUPERSEDED', supersededById: next.id, effectiveTo: new Date() },
      });
      return next;
    });
  }

  async revoke(organizationId: string, id: string): Promise<KnowledgeAssertion | null> {
    const found = await this.findById(organizationId, id);
    if (!found) return null;
    return this.prisma.knowledgeAssertion.update({
      where: { id: found.id },
      data: { status: 'REVOKED', effectiveTo: new Date() },
    });
  }

  listForSubject(
    organizationId: string,
    subjectIdentityId: string,
    opts: { status?: AssertionStatus; take?: number } = {},
  ): Promise<KnowledgeAssertion[]> {
    return this.prisma.knowledgeAssertion.findMany({
      where: {
        organizationId,
        subjectIdentityId,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { effectiveFrom: 'desc' },
      take: Math.min(MAX_TAKE, Math.max(1, opts.take ?? 100)),
    });
  }
}
