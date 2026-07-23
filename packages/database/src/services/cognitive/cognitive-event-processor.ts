// CognitiveEventProcessor — the canonical event → memory → state pipeline.
//
// The ONE place external/provider events become governed cognitive reality. It
// persists exclusively through the Increment 1 repositories (no second
// persistence layer, no direct Prisma from evaluators), gates all derivation
// through the GovernanceEvaluator (no bypass), and writes state only via the
// transactional applyStateChange (record + revision + evidence + outbox in one
// transaction). A provider is told "accepted" only when the accepted stages are
// durable; a stage failure returns accepted=false so the provider retries.
//
// Nine explicit stages:
//   1 IDEMPOTENCY  2 NORMALIZATION  3 IDENTITY_RESOLUTION  4 DURABLE_MEMORY
//   5 GOVERNANCE   6 KNOWLEDGE      7 ACTIVE_STATE         8 STATE_REVISION
//   9 PROCESSING_STATUS

import type { MemoryProcessingStatus, PrismaClient } from '@prisma/client';
import type { CognitiveRepositories } from '../../repositories/cognitive';
import { createCognitiveRepositories } from '../../repositories/cognitive';
import { normalizeEvent } from './normalization';
import { resolveIdentity } from './identity-resolution';
import { GovernanceEvaluator } from './governance-evaluator';
import { KnowledgeEvaluatorRegistry } from './knowledge-evaluators';
import { ActiveStateEvaluatorRegistry } from './active-state-evaluators';
import type { EvaluatorEvent, ProcessEventInput, ProcessResult } from './types';

const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 30_000;

const TERMINAL: MemoryProcessingStatus[] = ['STATE_UPDATED', 'PUBLISHED'];

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function safeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 500);
}
function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'PROCESSING_ERROR';
}

export interface ProcessorLogger {
  info?(event: string, fields: Record<string, unknown>): void;
  warn?(event: string, fields: Record<string, unknown>): void;
}

export class CognitiveEventProcessor {
  private readonly repos: CognitiveRepositories;

  constructor(
    prisma: PrismaClient,
    repos?: CognitiveRepositories,
    private readonly logger?: ProcessorLogger,
  ) {
    this.repos = repos ?? createCognitiveRepositories(prisma);
  }

  async processEvent(input: ProcessEventInput): Promise<ProcessResult> {
    const org = input.organizationId;
    if (!org) throw new Error('processEvent: organizationId is required (server-derived, never client)');
    const r = this.repos;

    // STAGE 1 — IDEMPOTENCY.
    const existing = await r.memoryEvents.findBySource(org, input.sourceSystem, input.sourceEventId);
    if (existing && TERMINAL.includes(existing.processingStatus)) {
      this.log('event.duplicate', { org, memoryEventId: existing.id });
      return {
        status: 'duplicate',
        accepted: true,
        memoryEventId: existing.id,
        subjectIdentityId: existing.subjectIdentityId,
      };
    }

    const attemptNumber = existing
      ? (await r.processingAttempts.listForMemoryEvent(org, existing.id)).length + 1
      : 1;
    const attempt = await r.processingAttempts.start(org, {
      memoryEventId: existing?.id ?? null,
      stage: 'IDEMPOTENCY',
      attemptNumber,
    });

    let stage = 'NORMALIZATION';
    let memoryEventId: string | null = existing?.id ?? null;
    let subjectIdentityId: string | null = existing?.subjectIdentityId ?? null;

    try {
      // STAGE 2 — NORMALIZATION (pure).
      const normalized = normalizeEvent(input);

      // STAGE 3 — IDENTITY_RESOLUTION.
      stage = 'IDENTITY_RESOLUTION';
      let resolutionMeta: Record<string, unknown> = {};
      if (input.subject) {
        const resolution = await resolveIdentity(
          org,
          input.subject,
          r,
          `anon:${input.sourceSystem}:${input.sourceEventId}`,
        );
        subjectIdentityId = resolution.identityId;
        resolutionMeta = { method: resolution.method, confidence: resolution.confidence };
      }

      // STAGE 4 — DURABLE_MEMORY (persisted BEFORE any state).
      stage = 'DURABLE_MEMORY';
      const memory = await r.memoryEvents.append(org, {
        eventType: normalized.eventType,
        occurredAt: normalized.occurredAt,
        sourceSystem: normalized.sourceSystem,
        sourceEventId: normalized.sourceEventId,
        subjectIdentityId,
        channel: normalized.channel,
        context: { ...normalized.context, resolution: resolutionMeta },
        payload: normalized.payload,
        sensitivity: normalized.sensitivity,
        consentBasis: normalized.consentBasis,
        permittedPurposes: normalized.requestedPurposes,
        aggregationEligibility: normalized.aggregationEligibility,
      });
      memoryEventId = memory.id;
      await r.processingAttempts.attachMemoryEvent(org, attempt.id, memory.id);
      await r.memoryEvents.setProcessingStatus(org, memory.id, 'MEMORY_PERSISTED');
      this.log('memory.persisted', { org, memoryEventId: memory.id, eventType: memory.eventType });

      const evEvent: EvaluatorEvent = {
        eventType: normalized.eventType,
        occurredAt: normalized.occurredAt,
        channel: normalized.channel,
        payload: normalized.payload,
      };

      // STAGE 5 — GOVERNANCE (deny-by-default; no evaluator may bypass it).
      stage = 'GOVERNANCE';
      const policies = await r.governancePolicies.findApplicable(org, {
        entityType: input.subject?.entityType ?? null,
        eventType: normalized.eventType,
      });
      const gov = GovernanceEvaluator.evaluate({
        policies,
        requestedPurposes: normalized.requestedPurposes,
        channel: normalized.channel,
        consentBasis: normalized.consentBasis,
        aggregation: normalized.aggregationEligibility,
      });

      // No subject, or governance denies → durable memory stands, no derivation.
      if (!subjectIdentityId || gov.outcome !== 'ALLOW') {
        if (gov.outcome !== 'ALLOW') {
          await r.decisions.record(org, {
            decisionType: 'governance.gate',
            decision: gov.outcome === 'REQUIRE_APPROVAL' ? 'ESCALATE' : 'SUPPRESS',
            subjectIdentityId,
            requestedPurpose: normalized.requestedPurposes[0] ?? null,
            channel: normalized.channel,
            policyEvaluation: { outcome: gov.outcome, reasons: gov.reasons },
            reason: gov.reasons.join('; '),
            requiresApproval: gov.outcome === 'REQUIRE_APPROVAL',
          });
          this.log('governance.denied', { org, memoryEventId: memory.id, outcome: gov.outcome });
        }
        await r.processingAttempts.succeed(org, attempt.id);
        return {
          status: gov.outcome !== 'ALLOW' ? 'denied' : 'processed',
          accepted: true,
          memoryEventId: memory.id,
          subjectIdentityId,
          governance: gov,
          stateChanged: false,
          assertionsWritten: 0,
        };
      }

      // STAGE 6 — KNOWLEDGE (idempotent: skip unchanged, supersede changed).
      stage = 'KNOWLEDGE';
      const persisted: Record<string, { id: string; value: unknown }> = {};
      for (const pa of KnowledgeEvaluatorRegistry.evaluate(evEvent)) {
        const expiresAt = pa.ttlMs ? new Date(normalized.occurredAt.getTime() + pa.ttlMs) : null;
        const active = await r.knowledgeAssertions.findActiveByPredicate(org, subjectIdentityId, pa.predicate);
        const common = {
          subjectIdentityId,
          predicate: pa.predicate,
          value: pa.value,
          valueType: pa.valueType,
          assertionClass: pa.assertionClass,
          confidence: pa.confidence,
          permittedPurposes: pa.permittedPurposes,
          sensitivity: pa.sensitivity,
          scope: pa.scope,
          consentBasis: normalized.consentBasis,
          sourceEventId: memory.id,
          expiresAt,
          ruleVersion: pa.ruleVersion,
        };
        if (active && sameJson(active.value, pa.value)) {
          persisted[pa.predicate] = { id: active.id, value: pa.value };
          continue;
        }
        if (active) {
          const next = await r.knowledgeAssertions.supersede(org, active.id, common);
          if (next) persisted[pa.predicate] = { id: next.id, value: pa.value };
        } else {
          const created = await r.knowledgeAssertions.create(org, common);
          persisted[pa.predicate] = { id: created.id, value: pa.value };
        }
      }

      // STAGE 7 + 8 — ACTIVE_STATE (only impacted keys) + transactional revision.
      stage = 'ACTIVE_STATE';
      const assertionsMap: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(persisted)) assertionsMap[k] = v.value;
      let stateChanged = false;
      for (const sc of ActiveStateEvaluatorRegistry.evaluate({ event: evEvent, assertions: assertionsMap })) {
        const evidence: Array<{ memoryEventId?: string; knowledgeAssertionId?: string }> = [
          { memoryEventId: memory.id },
        ];
        for (const pred of sc.evidencePredicates) {
          const a = persisted[pred];
          if (a) evidence.push({ knowledgeAssertionId: a.id });
        }
        stage = 'STATE_REVISION';
        const res = await r.activeState.applyStateChange(org, {
          identityId: subjectIdentityId,
          domain: sc.domain,
          stateKey: sc.stateKey,
          value: sc.value,
          valueType: sc.valueType,
          confidence: sc.confidence,
          sourceEventId: memory.id,
          lastChangedByEventId: memory.id,
          calculationRule: sc.ruleVersion,
          ruleVersion: sc.ruleVersion,
          expiresAt: sc.ttlMs ? new Date(normalized.occurredAt.getTime() + sc.ttlMs) : null,
          decayModel: sc.decayModel,
          scope: sc.scope,
          sensitivity: sc.sensitivity,
          permittedPurposes: sc.permittedPurposes,
          changeReason: sc.changeReason,
          evidence,
        });
        if (res.changed) stateChanged = true;
        stage = 'ACTIVE_STATE';
      }

      // STAGE 9 — PROCESSING_STATUS.
      stage = 'PROCESSING_STATUS';
      await r.memoryEvents.setProcessingStatus(
        org,
        memory.id,
        stateChanged ? 'STATE_UPDATED' : 'MEMORY_PERSISTED',
      );
      await r.processingAttempts.succeed(org, attempt.id);
      this.log('event.processed', {
        org,
        memoryEventId: memory.id,
        subjectIdentityId,
        stateChanged,
        assertions: Object.keys(persisted).length,
      });

      return {
        status: 'processed',
        accepted: true,
        memoryEventId: memory.id,
        subjectIdentityId,
        governance: gov,
        stateChanged,
        assertionsWritten: Object.keys(persisted).length,
      };
    } catch (e) {
      const deadLettered = attemptNumber >= MAX_ATTEMPTS;
      await r.processingAttempts.fail(org, attempt.id, {
        errorCode: errorCode(e),
        safeErrorMessage: safeMessage(e),
        nextRetryAt: deadLettered ? null : new Date(Date.now() + RETRY_BACKOFF_MS),
        deadLettered,
      });
      if (memoryEventId) {
        await r.memoryEvents.setProcessingStatus(
          org,
          memoryEventId,
          deadLettered ? 'DEAD_LETTERED' : 'FAILED',
        );
      }
      this.log('event.failed', { org, memoryEventId, stage, deadLettered, errorCode: errorCode(e) });
      // accepted=false: the event was NOT durably accepted end-to-end — retry.
      return {
        status: 'failed',
        accepted: false,
        memoryEventId,
        subjectIdentityId,
        failedStage: stage,
        errorCode: errorCode(e),
      };
    }
  }

  /**
   * Re-run a recoverable failed/partial event. Idempotent: memory is not
   * duplicated (append returns the existing row), knowledge is skipped when
   * unchanged, and unchanged state writes no revision/outbox. Safe to call for
   * any event whose last memory status is FAILED or MEMORY_PERSISTED.
   */
  async retry(input: ProcessEventInput): Promise<ProcessResult> {
    return this.processEvent(input);
  }

  private log(event: string, fields: Record<string, unknown>): void {
    // Structured only; never raw payloads or secrets.
    this.logger?.info?.(event, fields);
  }
}
