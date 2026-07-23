// IntelligenceHypothesisRepository — patterns that APPEAR to exist but are not
// yet accepted organizational truth.
//
// Hard invariant: a hypothesis is only ever CREATED as PROPOSED. There is NO
// code path that auto-accepts — acceptance requires an explicit, attributed
// human action (accept() demands a non-empty acceptedBy). AI-generated
// hypotheses are subject to the same rule, so an AI model can never promote its
// own guess into accepted truth. This repository stores hypotheses; it does not
// generate them (no engine, no aggregate intelligence in this foundation).

import type {
  PrismaClient,
  IntelligenceHypothesis,
  HypothesisStatus,
  HypothesisGeneratedBy,
  DataScope,
  DataSensitivity,
  DataPurpose,
} from '@prisma/client';

export interface ProposeHypothesisInput {
  hypothesisType: string;
  title: string;
  summary?: string | null;
  subjectIdentityId?: string | null;
  confidence?: number | null;
  evidenceCount?: number;
  supportingWindowStart?: Date | null;
  supportingWindowEnd?: Date | null;
  scope?: DataScope;
  sensitivity?: DataSensitivity;
  permittedPurposes?: DataPurpose[];
  generatedBy: HypothesisGeneratedBy;
  ruleVersion?: string | null;
}

export class IntelligenceHypothesisRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Always creates a PROPOSED hypothesis — never ACCEPTED, regardless of source. */
  propose(organizationId: string, input: ProposeHypothesisInput): Promise<IntelligenceHypothesis> {
    return this.prisma.intelligenceHypothesis.create({
      data: {
        organizationId,
        hypothesisType: input.hypothesisType,
        title: input.title,
        summary: input.summary ?? null,
        subjectIdentityId: input.subjectIdentityId ?? null,
        status: 'PROPOSED',
        confidence: input.confidence ?? null,
        evidenceCount: input.evidenceCount ?? 0,
        supportingWindowStart: input.supportingWindowStart ?? null,
        supportingWindowEnd: input.supportingWindowEnd ?? null,
        scope: input.scope ?? 'INDIVIDUAL',
        sensitivity: input.sensitivity ?? 'INTERNAL',
        permittedPurposes: input.permittedPurposes ?? [],
        generatedBy: input.generatedBy,
        ruleVersion: input.ruleVersion ?? null,
      },
    });
  }

  findById(organizationId: string, id: string): Promise<IntelligenceHypothesis | null> {
    return this.prisma.intelligenceHypothesis.findFirst({ where: { id, organizationId } });
  }

  /** Explicit human acceptance. Requires an attributed actor; fails closed otherwise. */
  async accept(
    organizationId: string,
    id: string,
    acceptedBy: string,
  ): Promise<IntelligenceHypothesis | null> {
    if (!acceptedBy || acceptedBy.trim().length === 0) {
      throw new Error('Accepting a hypothesis requires an attributed actor (acceptedBy)');
    }
    const found = await this.findById(organizationId, id);
    if (!found) return null;
    return this.prisma.intelligenceHypothesis.update({
      where: { id: found.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedBy },
    });
  }

  async reject(
    organizationId: string,
    id: string,
    rejectedBy: string,
  ): Promise<IntelligenceHypothesis | null> {
    const found = await this.findById(organizationId, id);
    if (!found) return null;
    return this.prisma.intelligenceHypothesis.update({
      where: { id: found.id },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectedBy: rejectedBy || null },
    });
  }

  list(
    organizationId: string,
    opts: { status?: HypothesisStatus; subjectIdentityId?: string; take?: number } = {},
  ): Promise<IntelligenceHypothesis[]> {
    return this.prisma.intelligenceHypothesis.findMany({
      where: {
        organizationId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.subjectIdentityId ? { subjectIdentityId: opts.subjectIdentityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, opts.take ?? 100)),
    });
  }
}
