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

  /**
   * Replace one hypothesis with a newer one, preserving the old in full.
   *
   * SUPERSESSION IS NOT AN EDIT. The old row keeps its claim, its evidence
   * counts, its window and its generator exactly as written; all it gains is a
   * terminal status and a pointer to what replaced it. This is the only way a
   * claim's body may ever change, and it changes by there being a second row.
   *
   * FAILS CLOSED IN FOUR WAYS. Both rows must belong to the organization, they
   * must be different rows, the successor must not itself be superseded, and a
   * row that already names a DIFFERENT successor is refused rather than
   * repointed -- a supersession chain that can be rewritten is a history that
   * can be rewritten.
   *
   * IDEMPOTENT. Re-superseding by the same successor returns the row unchanged,
   * so an interrupted caller can safely retry.
   */
  async supersede(
    organizationId: string,
    id: string,
    supersededById: string,
  ): Promise<IntelligenceHypothesis | null> {
    if (id === supersededById) {
      throw new Error('A hypothesis cannot supersede itself');
    }
    const [found, successor] = await Promise.all([
      this.findById(organizationId, id),
      this.findById(organizationId, supersededById),
    ]);
    if (!found || !successor) return null;
    if (successor.supersededById) {
      throw new Error('A superseded hypothesis cannot supersede another');
    }
    if (found.supersededById) {
      // Already done, or already done differently. The first is a retry; the
      // second is an attempt to rewrite lineage and is refused.
      if (found.supersededById === supersededById) return found;
      throw new Error('This hypothesis was already superseded by a different one');
    }
    return this.prisma.intelligenceHypothesis.update({
      where: { id: found.id },
      data: { status: 'SUPERSEDED', supersededById },
    });
  }

  /**
   * Everything this hypothesis replaced, walking backwards, newest first.
   *
   * READ BACKWARDS FROM THE CURRENT CLAIM, because that is the direction the
   * pointer does not exist in: a row names what replaced IT, so finding what it
   * replaced is a query rather than a field. Bounded, so a cycle written by some
   * future bug cannot hang a page.
   */
  async lineageOf(
    organizationId: string,
    id: string,
    maxDepth = 50,
  ): Promise<IntelligenceHypothesis[]> {
    const out: IntelligenceHypothesis[] = [];
    const seen = new Set<string>([id]);
    let current = id;
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const previous = await this.prisma.intelligenceHypothesis.findFirst({
        where: { organizationId, supersededById: current },
        orderBy: { createdAt: 'desc' },
      });
      if (!previous || seen.has(previous.id)) break;
      seen.add(previous.id);
      out.push(previous);
      current = previous.id;
    }
    return out;
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
