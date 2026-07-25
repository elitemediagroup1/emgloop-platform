// CognitiveDecisionRepository — WHAT decision was made from state, policy, and
// evidence. This RECORDS decisions; it does NOT execute external sends. A
// RECOMMEND or CREATE_WORK decision is a durable record with its input state
// snapshot and policy evaluation attached, not an action. Execution is a
// deliberate, separate step in a later phase.

import type {
  PrismaClient,
  CognitiveDecision,
  DecisionOutcome,
  DataPurpose,
  Prisma,
} from '@prisma/client';

export interface RecordDecisionInput {
  decisionType: string;
  decision: DecisionOutcome;
  subjectIdentityId?: string | null;
  requestedPurpose?: DataPurpose | null;
  channel?: string | null;
  inputStateSnapshot?: Record<string, unknown>;
  policyEvaluation?: Record<string, unknown>;
  reason?: string | null;
  confidence?: number | null;
  requiresApproval?: boolean;
  /**
   * Stable dedup key from (state revision, policy id, policy version) — never a
   * timestamp. When set, the (organizationId, idempotencyKey) unique makes a
   * repeated policy evaluation over the same revision a P2002 no-op. Callers that
   * want idempotency use recordIdempotent().
   */
  idempotencyKey?: string | null;
}

export class CognitiveDecisionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  record(organizationId: string, input: RecordDecisionInput): Promise<CognitiveDecision> {
    return this.prisma.cognitiveDecision.create({
      data: {
        organizationId,
        decisionType: input.decisionType,
        decision: input.decision,
        subjectIdentityId: input.subjectIdentityId ?? null,
        requestedPurpose: input.requestedPurpose ?? null,
        channel: input.channel ?? null,
        inputStateSnapshot: (input.inputStateSnapshot ?? {}) as Prisma.InputJsonValue,
        policyEvaluation: (input.policyEvaluation ?? {}) as Prisma.InputJsonValue,
        reason: input.reason ?? null,
        confidence: input.confidence ?? null,
        requiresApproval: input.requiresApproval ?? false,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
  }

  /**
   * Record a decision idempotently by its (revision, policy, version) key. If a
   * decision with that key already exists (P2002), returns the existing row
   * instead of creating a duplicate — so a re-run of the decision subscriber over
   * the same state revision produces exactly one decision. Requires a non-empty
   * idempotencyKey on the input.
   */
  async recordIdempotent(
    organizationId: string,
    input: RecordDecisionInput & { idempotencyKey: string },
  ): Promise<CognitiveDecision> {
    try {
      return await this.record(organizationId, input);
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        const existing = await this.prisma.cognitiveDecision.findFirst({
          where: { organizationId, idempotencyKey: input.idempotencyKey },
        });
        if (existing) return existing;
      }
      throw e;
    }
  }

  findById(organizationId: string, id: string): Promise<CognitiveDecision | null> {
    return this.prisma.cognitiveDecision.findFirst({ where: { id, organizationId } });
  }

  /** Approve a decision that required approval. Does not execute it. */
  async approve(
    organizationId: string,
    id: string,
    approvedBy: string,
  ): Promise<CognitiveDecision | null> {
    const found = await this.findById(organizationId, id);
    if (!found) return null;
    return this.prisma.cognitiveDecision.update({
      where: { id: found.id },
      data: { approvedAt: new Date(), approvedBy: approvedBy || null },
    });
  }

  list(
    organizationId: string,
    opts: { decisionType?: string; subjectIdentityId?: string; take?: number } = {},
  ): Promise<CognitiveDecision[]> {
    return this.prisma.cognitiveDecision.findMany({
      where: {
        organizationId,
        ...(opts.decisionType ? { decisionType: opts.decisionType } : {}),
        ...(opts.subjectIdentityId ? { subjectIdentityId: opts.subjectIdentityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, opts.take ?? 100)),
    });
  }
}
