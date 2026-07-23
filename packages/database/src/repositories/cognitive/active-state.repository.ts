// ActiveStateRepository + StateChangeOutboxRepository — explainable current state.
//
// WHAT IS CURRENTLY TRUE, as a derived, domain-scoped projection, plus the WHY
// (evidence), the audit trail (revision), and the publish intent (outbox).
//
// The correctness spine of the whole architecture lives in applyStateChange():
//   - the state write, its revision, its evidence, and the outbox row all commit
//     in ONE database transaction (transactional outbox pattern). Nothing is
//     published before that transaction commits.
//   - an unchanged value produces NO revision and NO outbox row — only
//     lastEvaluatedAt advances. A false state change must never be published.
//   - every state change produces exactly one revision.
//
// Evidence must cite at least one of a memory event, knowledge assertion, or
// relationship — a non-static state without inspectable evidence is rejected.

import { Prisma } from '@prisma/client';
import type {
  PrismaClient,
  ActiveStateRecord,
  ActiveStateRevision,
  ActiveStateEvidence,
  StateChangeOutbox,
  ActiveStateDomain,
  ActiveStateStatus,
  CognitiveValueType,
  DecayModel,
  DataScope,
  DataSensitivity,
  DataPurpose,
  OutboxStatus,
} from '@prisma/client';

// Stable stringify so value comparison is order-independent for JSON objects.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`;
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export interface StateEvidenceInput {
  memoryEventId?: string | null;
  knowledgeAssertionId?: string | null;
  relationshipId?: string | null;
  weight?: number | null;
  contribution?: number | null;
  observedAt?: Date;
}

export interface ApplyStateChangeInput {
  identityId: string;
  domain: ActiveStateDomain;
  stateKey: string;
  value: unknown;
  valueType?: CognitiveValueType;
  confidence?: number | null;
  status?: ActiveStateStatus;
  sourceEventId?: string | null;
  lastChangedByEventId?: string | null;
  calculationRule?: string | null;
  ruleVersion?: string | null;
  expiresAt?: Date | null;
  decayModel?: DecayModel;
  scope?: DataScope;
  sensitivity?: DataSensitivity;
  permittedPurposes?: DataPurpose[];
  changeReason?: string | null;
  /** Evidence for WHY the state holds this value. Required for a real change. */
  evidence?: StateEvidenceInput[];
}

export interface ApplyStateChangeResult {
  changed: boolean;
  record: ActiveStateRecord;
  revision: ActiveStateRevision | null;
  outbox: StateChangeOutbox | null;
}

function hasReference(e: StateEvidenceInput): boolean {
  return Boolean(e.memoryEventId || e.knowledgeAssertionId || e.relationshipId);
}

export class ActiveStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  getState(
    organizationId: string,
    identityId: string,
    domain: ActiveStateDomain,
    stateKey: string,
  ): Promise<ActiveStateRecord | null> {
    return this.prisma.activeStateRecord.findFirst({
      where: { organizationId, identityId, domain, stateKey },
    });
  }

  /** Resolve a state record by id WITHIN the org; cross-org id → null. */
  findRecordById(organizationId: string, id: string): Promise<ActiveStateRecord | null> {
    return this.prisma.activeStateRecord.findFirst({ where: { id, organizationId } });
  }

  listForIdentity(
    organizationId: string,
    identityId: string,
    opts: { domains?: ActiveStateDomain[]; includeExpired?: boolean; now?: Date } = {},
  ): Promise<ActiveStateRecord[]> {
    const now = opts.now ?? new Date();
    return this.prisma.activeStateRecord.findMany({
      where: {
        organizationId,
        identityId,
        ...(opts.domains && opts.domains.length ? { domain: { in: opts.domains } } : {}),
        ...(opts.includeExpired
          ? {}
          : {
              status: 'ACTIVE',
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            }),
      },
      orderBy: [{ domain: 'asc' }, { stateKey: 'asc' }],
    });
  }

  listEvidence(
    organizationId: string,
    activeStateRecordId: string,
  ): Promise<ActiveStateEvidence[]> {
    return this.prisma.activeStateEvidence.findMany({
      where: { organizationId, activeStateRecordId },
      orderBy: { observedAt: 'desc' },
    });
  }

  listRevisions(
    organizationId: string,
    activeStateRecordId: string,
  ): Promise<ActiveStateRevision[]> {
    return this.prisma.activeStateRevision.findMany({
      where: { organizationId, activeStateRecordId },
      orderBy: { changedAt: 'desc' },
    });
  }

  /**
   * Apply a recalculated state value. See file header for the invariants this
   * upholds. When the value AND confidence are unchanged, only lastEvaluatedAt
   * advances and no revision/outbox is written (changed=false). Otherwise the
   * record upsert, one revision, its evidence, and the outbox row all commit
   * atomically (changed=true).
   */
  async applyStateChange(
    organizationId: string,
    input: ApplyStateChangeInput,
  ): Promise<ApplyStateChangeResult> {
    const evidence = (input.evidence ?? []).filter(hasReference);
    const existing = await this.getState(
      organizationId,
      input.identityId,
      input.domain,
      input.stateKey,
    );

    const nextValue = (input.value ?? {}) as Prisma.InputJsonValue;
    const nextConfidence = input.confidence ?? null;
    const now = new Date();

    // Unchanged: no revision, no outbox, no false publish.
    if (
      existing &&
      sameValue(existing.value, input.value ?? {}) &&
      existing.confidence === nextConfidence &&
      (input.status === undefined || input.status === existing.status)
    ) {
      const record = await this.prisma.activeStateRecord.update({
        where: { id: existing.id },
        data: { lastEvaluatedAt: now },
      });
      return { changed: false, record, revision: null, outbox: null };
    }

    // A real, non-static change must carry evidence.
    if (evidence.length === 0) {
      throw new Error(
        `ActiveState change for ${input.domain}/${input.stateKey} requires at least one evidence reference`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const record = existing
        ? await tx.activeStateRecord.update({
            where: { id: existing.id },
            data: {
              value: nextValue,
              valueType: input.valueType ?? existing.valueType,
              confidence: nextConfidence,
              status: input.status ?? 'ACTIVE',
              sourceEventId: input.sourceEventId ?? existing.sourceEventId,
              lastChangedByEventId: input.lastChangedByEventId ?? input.sourceEventId ?? null,
              calculationRule: input.calculationRule ?? existing.calculationRule,
              ruleVersion: input.ruleVersion ?? existing.ruleVersion,
              expiresAt: input.expiresAt ?? null,
              decayModel: input.decayModel ?? existing.decayModel,
              scope: input.scope ?? existing.scope,
              sensitivity: input.sensitivity ?? existing.sensitivity,
              permittedPurposes: input.permittedPurposes ?? existing.permittedPurposes,
              effectiveAt: now,
              lastEvaluatedAt: now,
            },
          })
        : await tx.activeStateRecord.create({
            data: {
              organizationId,
              identityId: input.identityId,
              domain: input.domain,
              stateKey: input.stateKey,
              value: nextValue,
              valueType: input.valueType ?? 'STRING',
              confidence: nextConfidence,
              status: input.status ?? 'ACTIVE',
              sourceEventId: input.sourceEventId ?? null,
              lastChangedByEventId: input.lastChangedByEventId ?? input.sourceEventId ?? null,
              calculationRule: input.calculationRule ?? null,
              ruleVersion: input.ruleVersion ?? null,
              expiresAt: input.expiresAt ?? null,
              decayModel: input.decayModel ?? 'NONE',
              scope: input.scope ?? 'INDIVIDUAL',
              sensitivity: input.sensitivity ?? 'INTERNAL',
              permittedPurposes: input.permittedPurposes ?? [],
              effectiveAt: now,
              lastEvaluatedAt: now,
            },
          });

      const revision = await tx.activeStateRevision.create({
        data: {
          organizationId,
          activeStateRecordId: record.id,
          previousValue: existing ? (existing.value as Prisma.InputJsonValue) : Prisma.DbNull,
          newValue: nextValue,
          previousConfidence: existing ? existing.confidence : null,
          newConfidence: nextConfidence,
          changeReason: input.changeReason ?? null,
          sourceEventId: input.sourceEventId ?? null,
          ruleVersion: input.ruleVersion ?? null,
          // Tie the revision timestamp to the transaction clock (same `now` as the
          // evidence and outbox rows) rather than a marginally-later DB default.
          changedAt: now,
        },
      });

      for (const e of evidence) {
        await tx.activeStateEvidence.create({
          data: {
            organizationId,
            activeStateRecordId: record.id,
            memoryEventId: e.memoryEventId ?? null,
            knowledgeAssertionId: e.knowledgeAssertionId ?? null,
            relationshipId: e.relationshipId ?? null,
            weight: e.weight ?? null,
            contribution: e.contribution ?? null,
            observedAt: e.observedAt ?? now,
          },
        });
      }

      const outbox = await tx.stateChangeOutbox.create({
        data: {
          organizationId,
          identityId: input.identityId,
          domain: input.domain,
          stateKey: input.stateKey,
          changeType: existing ? 'UPDATED' : 'CREATED',
          activeStateRecordId: record.id,
          activeStateRevisionId: revision.id,
          payload: {
            domain: input.domain,
            stateKey: input.stateKey,
            value: nextValue,
            confidence: nextConfidence,
            changeType: existing ? 'UPDATED' : 'CREATED',
          } as Prisma.InputJsonValue,
          status: 'PENDING',
          availableAt: now,
        },
      });

      return { changed: true, record, revision, outbox };
    });
  }
}

// ---------------------------------------------------------------------------
// StateChangeOutboxRepository — drained by the publisher (Increment 3).
// ---------------------------------------------------------------------------

export class StateChangeOutboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(organizationId: string, id: string): Promise<StateChangeOutbox | null> {
    return this.prisma.stateChangeOutbox.findFirst({ where: { id, organizationId } });
  }

  listPending(
    organizationId: string,
    opts: { take?: number; now?: Date } = {},
  ): Promise<StateChangeOutbox[]> {
    const now = opts.now ?? new Date();
    return this.prisma.stateChangeOutbox.findMany({
      where: { organizationId, status: 'PENDING', availableAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: Math.min(500, Math.max(1, opts.take ?? 100)),
    });
  }

  /**
   * Rows the publisher should examine this pass: due PENDING rows (newly ready)
   * plus every PROCESSING row (in-flight — some delivery may still be retrying).
   * A PROCESSING row is revisited each pass until every matched delivery is
   * terminal, so nothing is stranded. Ordered by createdAt for stable ordering.
   */
  listActiveForPublish(
    organizationId: string,
    opts: { take?: number; now?: Date } = {},
  ): Promise<StateChangeOutbox[]> {
    const now = opts.now ?? new Date();
    return this.prisma.stateChangeOutbox.findMany({
      where: {
        organizationId,
        OR: [
          { status: 'PENDING', availableAt: { lte: now } },
          { status: 'PROCESSING' },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(500, Math.max(1, opts.take ?? 100)),
    });
  }

  /**
   * Atomically claim a single PENDING row into PROCESSING. This is a conditional
   * UPDATE (`updateMany where status='PENDING'`), NOT a read-then-write: exactly
   * one competing worker gets count===1 and owns the row; the loser gets 0. No
   * raw SQL, no in-memory lock — the database row is the mutex.
   */
  async markProcessing(
    organizationId: string,
    id: string,
  ): Promise<boolean> {
    const res = await this.prisma.stateChangeOutbox.updateMany({
      where: { id, organizationId, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
    return res.count === 1;
  }

  /** Terminal failure of the parent (a REQUIRED delivery dead-lettered). */
  async markDeadLettered(
    organizationId: string,
    id: string,
    error: string,
  ): Promise<StateChangeOutbox | null> {
    const found = await this.prisma.stateChangeOutbox.findFirst({ where: { id, organizationId } });
    if (!found) return null;
    return this.prisma.stateChangeOutbox.update({
      where: { id: found.id },
      data: { status: 'DEAD_LETTERED', lastError: error.slice(0, 500) },
    });
  }

  /**
   * Claim a batch of due PENDING rows by flipping them to PROCESSING. Ordered by
   * createdAt so per-identity ordering is preserved in practice. Returns the
   * claimed rows.
   */
  async claimBatch(
    organizationId: string,
    opts: { take?: number; now?: Date } = {},
  ): Promise<StateChangeOutbox[]> {
    const due = await this.listPending(organizationId, opts);
    const claimed: StateChangeOutbox[] = [];
    for (const row of due) {
      claimed.push(
        await this.prisma.stateChangeOutbox.update({
          where: { id: row.id },
          data: { status: 'PROCESSING', attemptCount: { increment: 1 } },
        }),
      );
    }
    return claimed;
  }

  async markPublished(organizationId: string, id: string): Promise<StateChangeOutbox | null> {
    const found = await this.prisma.stateChangeOutbox.findFirst({ where: { id, organizationId } });
    if (!found) return null;
    return this.prisma.stateChangeOutbox.update({
      where: { id: found.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(), lastError: null },
    });
  }

  async markFailed(
    organizationId: string,
    id: string,
    error: string,
    opts: { maxAttempts?: number; retryDelayMs?: number; now?: Date } = {},
  ): Promise<StateChangeOutbox | null> {
    const found = await this.prisma.stateChangeOutbox.findFirst({ where: { id, organizationId } });
    if (!found) return null;
    const maxAttempts = opts.maxAttempts ?? 5;
    const now = opts.now ?? new Date();
    const deadLettered = found.attemptCount >= maxAttempts;
    const nextStatus: OutboxStatus = deadLettered ? 'DEAD_LETTERED' : 'PENDING';
    return this.prisma.stateChangeOutbox.update({
      where: { id: found.id },
      data: {
        status: nextStatus,
        lastError: error.slice(0, 500),
        availableAt: deadLettered
          ? found.availableAt
          : new Date(now.getTime() + (opts.retryDelayMs ?? 30_000)),
      },
    });
  }
}
