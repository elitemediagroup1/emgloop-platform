// CognitiveProcessingAttemptRepository — retry/dead-letter foundation (Increment 2).
//
// Records one row per attempt at one processing stage. This is what makes
// failures RECOVERABLE (a FAILED attempt with a nextRetryAt is queryable and
// re-runnable) and dead-lettered events INSPECTABLE. Error text is stored as a
// SAFE message only — never a raw payload or secret.

import type {
  PrismaClient,
  CognitiveProcessingAttempt,
  ProcessingAttemptStatus,
} from '@prisma/client';

export interface StartAttemptInput {
  memoryEventId?: string | null;
  stage: string;
  attemptNumber?: number;
}

export interface FailAttemptInput {
  errorCode?: string | null;
  safeErrorMessage?: string | null;
  nextRetryAt?: Date | null;
  deadLettered?: boolean;
}

export class CognitiveProcessingAttemptRepository {
  constructor(private readonly prisma: PrismaClient) {}

  start(organizationId: string, input: StartAttemptInput): Promise<CognitiveProcessingAttempt> {
    return this.prisma.cognitiveProcessingAttempt.create({
      data: {
        organizationId,
        memoryEventId: input.memoryEventId ?? null,
        stage: input.stage,
        attemptNumber: input.attemptNumber ?? 1,
        status: 'PROCESSING',
      },
    });
  }

  /** Link an attempt to the memory event once it has been created (stage 4). */
  async attachMemoryEvent(
    organizationId: string,
    id: string,
    memoryEventId: string,
  ): Promise<CognitiveProcessingAttempt | null> {
    const found = await this.prisma.cognitiveProcessingAttempt.findFirst({
      where: { id, organizationId },
    });
    if (!found) return null;
    return this.prisma.cognitiveProcessingAttempt.update({
      where: { id: found.id },
      data: { memoryEventId },
    });
  }

  async succeed(
    organizationId: string,
    id: string,
  ): Promise<CognitiveProcessingAttempt | null> {
    const found = await this.prisma.cognitiveProcessingAttempt.findFirst({
      where: { id, organizationId },
    });
    if (!found) return null;
    return this.prisma.cognitiveProcessingAttempt.update({
      where: { id: found.id },
      data: { status: 'SUCCEEDED', completedAt: new Date(), nextRetryAt: null },
    });
  }

  async fail(
    organizationId: string,
    id: string,
    input: FailAttemptInput,
  ): Promise<CognitiveProcessingAttempt | null> {
    const found = await this.prisma.cognitiveProcessingAttempt.findFirst({
      where: { id, organizationId },
    });
    if (!found) return null;
    const status: ProcessingAttemptStatus = input.deadLettered ? 'DEAD_LETTERED' : 'FAILED';
    return this.prisma.cognitiveProcessingAttempt.update({
      where: { id: found.id },
      data: {
        status,
        // Truncate defensively; never store raw payloads.
        safeErrorMessage: input.safeErrorMessage ? input.safeErrorMessage.slice(0, 500) : null,
        errorCode: input.errorCode ?? null,
        completedAt: new Date(),
        nextRetryAt: input.deadLettered ? null : input.nextRetryAt ?? null,
      },
    });
  }

  /** Retryable attempts whose backoff has elapsed. */
  listRetryable(
    organizationId: string,
    opts: { now?: Date; take?: number } = {},
  ): Promise<CognitiveProcessingAttempt[]> {
    const now = opts.now ?? new Date();
    return this.prisma.cognitiveProcessingAttempt.findMany({
      where: { organizationId, status: 'FAILED', nextRetryAt: { lte: now } },
      orderBy: { nextRetryAt: 'asc' },
      take: Math.min(500, Math.max(1, opts.take ?? 100)),
    });
  }

  listDeadLettered(
    organizationId: string,
    opts: { take?: number } = {},
  ): Promise<CognitiveProcessingAttempt[]> {
    return this.prisma.cognitiveProcessingAttempt.findMany({
      where: { organizationId, status: 'DEAD_LETTERED' },
      orderBy: { completedAt: 'desc' },
      take: Math.min(500, Math.max(1, opts.take ?? 100)),
    });
  }

  listForMemoryEvent(
    organizationId: string,
    memoryEventId: string,
  ): Promise<CognitiveProcessingAttempt[]> {
    return this.prisma.cognitiveProcessingAttempt.findMany({
      where: { organizationId, memoryEventId },
      orderBy: { startedAt: 'asc' },
    });
  }
}
