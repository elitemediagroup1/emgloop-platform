// The domain producer kit. Loop Intelligence Phase D/E, 2026-09-26.
//
// EVERY DOMAIN READS THE SAME WAY, SO EVERY DOMAIN IS BUILT THE SAME WAY:
//
//   gather   Loop's OWN governed records for the target (repositories only), reduced to a deterministic
//            context and a FINGERPRINT of everything that should change the reading.
//   rule     a deterministic reading of that context: the statement, the status, and the signals Loop can
//            state itself -- MEASURED figures (with their metric) and OBSERVED record facts. This always
//            runs; it is the floor, and it is honest without any model.
//   model    OPTIONAL. When the domain's reading task is ACTIVATED (the runner says so) and a principal
//            may invoke it, the domain-reading.v1 task reads the same context -- aggregates and canonical
//            references, never raw source payloads -- and its reading replaces the rule's statement, while
//            the rule's MEASURED signals are kept beside the model's (which can never be MEASURED). If the
//            model is not activated or does not answer, the rule reading is written, and says so.
//
// Favor deterministic extraction before AI: a model is asked only for what the rule cannot say, only when
// the fingerprint changed (the loop skips unchanged input before `read`), and only inside the lane and
// budget its route names.

import {
  INTELLIGENCE_DOMAIN_SUBJECT_REF,
  intelligenceSignalsRefusals,
  validateAiContextPackage,
  type AiContextItem,
  type AiSupportedEvidence,
  type AiTaskDefinition,
  type IntelligenceDomain,
  type IntelligenceGeneratedCoverage,
  type IntelligenceOrdinal,
  type IntelligenceReadingStatus,
  type IntelligenceSignal,
  type IntelligenceSourceUse,
  type IntelligenceSubjectKind,
} from '@emgloop/shared';

import type { IntelligenceDigestInput } from '../../repositories/intelligence/intelligence-digest.repository';
import type { IntelligenceRefreshTarget } from '../../repositories/intelligence/intelligence-refresh-queue.repository';
import type { AiPrincipal } from '../ai-runtime/gateway';
import type { DomainReadingService } from '../ai-runtime/domain-reading.service';
import { DOMAIN_READING_TEMPLATE_VERSION, type DomainReadingFraming } from '../ai-runtime/templates/domain-reading';
import type { IntelligenceGatherResult, IntelligenceProducer, IntelligenceReadResult } from './producer';

/** What a rule reading says. Signals may be MEASURED (with a metric) or OBSERVED record facts. */
export interface RuleReading {
  readonly statement: string;
  readonly status: IntelligenceReadingStatus;
  readonly confidence: IntelligenceOrdinal;
  readonly signals: readonly IntelligenceSignal[];
  readonly limitations: readonly string[];
  readonly entityRefs: readonly string[];
  readonly coverage: IntelligenceGeneratedCoverage;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly evidenceCount: number;
  readonly lastEvidenceAt: Date | null;
  readonly sources: readonly IntelligenceSourceUse[];
  /** Keyed references to the records read. */
  readonly sourceRefs: readonly string[];
}

export interface ModelStage<C> {
  readonly task: AiTaskDefinition;
  readonly framing: DomainReadingFraming;
  /** The context package items and the grounding evidence for the model, from the SAME gathered context. */
  context(ctx: C, rule: RuleReading): { readonly items: readonly AiContextItem[]; readonly evidence: AiSupportedEvidence };
}

export interface DomainKitPorts {
  /** Whether the task is ACTIVATED in this deployment (LOOP_AI_TASKS). False: no call is made at all. */
  readonly modelEnabled: (taskId: string) => boolean;
  readonly reader: Pick<DomainReadingService, 'read'> | null;
  /** Who a model reading runs as: the principal for a PRINCIPAL target, the organization's acting principal otherwise. */
  readonly principalFor: (target: IntelligenceRefreshTarget) => Promise<AiPrincipal | null>;
  /**
   * Whether this target's reading task had an answer REJECTED by Loop since `since`, under this task and
   * template version (the AI usage ledger). True: the kit does not pay again inside the backoff and writes
   * the rule reading. Absent: no backoff.
   */
  readonly modelRejectedSince?: (q: {
    readonly organizationId: string;
    /** The principal for a PRINCIPAL target; null for an ORGANIZATION target (its one reading, whoever ran it). */
    readonly userId: string | null;
    readonly taskId: string;
    readonly taskVersion: string;
    readonly templateVersion: string;
    readonly since: Date;
  }) => Promise<boolean>;
  /** The same question for a provider call that FAILED (MODEL_FAILURE_BACKOFF_MS). Absent: no failure backoff. */
  readonly modelFailedSince?: (q: {
    readonly organizationId: string;
    readonly userId: string | null;
    readonly taskId: string;
    readonly taskVersion: string;
    readonly templateVersion: string;
    readonly since: Date;
  }) => Promise<boolean>;
}

/**
 * After an answer Loop REJECTED, the same reading is not paid for again for this long, whatever the evidence
 * does: at most one discarded answer per subject per task and template version per day. The class cap and
 * circuit breaker bound the organization; this bounds one subject whose evidence keeps moving (a calendar).
 * A new template or task version is a new question and is asked at once.
 */
export const MODEL_REJECTION_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * After a provider call FAILED (timeout, 429, 5xx, a ledger that could not record), the same reading is not
 * attempted again for this long. Without it a failing provider was retried on every pass (every 15 minutes)
 * for every domain: a hidden loop spending the BACKGROUND lane Telegram hydration shares, since a failed call
 * still counts as an invocation. At most eight failed attempts per subject per day; the rule reading stands
 * meanwhile, and the next attempt after the window happens without the evidence having to change.
 */
export const MODEL_FAILURE_BACKOFF_MS = 3 * 60 * 60 * 1000;

export interface DomainProducerSpec<C> {
  readonly id: string;
  readonly domain: IntelligenceDomain;
  readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly subjectKinds?: readonly IntelligenceSubjectKind[];
  readonly version: string;
  /** The provider a PRINCIPAL digest is drawn from (consent withdrawal), or null for Loop records. */
  readonly provider: string | null;
  readonly consentBasis: IntelligenceDigestInput['consentBasis'];
  gather(target: IntelligenceRefreshTarget, now: Date): Promise<IntelligenceGatherResult<C>>;
  rule(ctx: C, now: Date): RuleReading;
  readonly model?: ModelStage<C>;
  discover?(now: Date): Promise<readonly IntelligenceRefreshTarget[]>;
}

const MAX_SIGNALS = 12;

/** How a producer reads right now: rule only, rule with its task off, or rule plus the task at its versions. */
function identityOf<C>(spec: DomainProducerSpec<C>, ports: DomainKitPorts): string {
  if (!spec.model) return 'rule';
  return ports.reader && ports.modelEnabled(spec.model.task.taskId)
    ? `model:${spec.model.task.taskId}@${spec.model.task.version}/${spec.model.task.outputSchemaId}/${DOMAIN_READING_TEMPLATE_VERSION}`
    : `rule;model-off:${spec.model.task.taskId}`;
}

/**
 * The rule's signals with the model's appended, each model key prefixed `m.` and kept inside the key grammar
 * (a key the prefix would push past 64 characters is cut BEFORE prefixing, and a key that then repeats one
 * already taken is dropped, never renamed), capped at the digest's signal limit. Returns the refusals the
 * digest contract would give the merged list; empty means it can be stored.
 */
export function mergeModelReading(rule: readonly IntelligenceSignal[], model: readonly IntelligenceSignal[], scope: 'PRINCIPAL' | 'ORGANIZATION'): { signals: IntelligenceSignal[]; refusals: string[] } {
  const taken = new Set(rule.map((s) => s.key));
  const out: IntelligenceSignal[] = [...rule];
  for (const s of model) {
    const key = `m.${s.key.slice(0, 62)}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ ...s, key });
  }
  const signals = out.slice(0, MAX_SIGNALS);
  return { signals, refusals: intelligenceSignalsRefusals(signals, { scope, producerKind: 'RULE_AND_MODEL' }) };
}

/** A domain producer from a spec: rule reading always, model reading when activated. */
export function domainProducer<C>(spec: DomainProducerSpec<C>, ports: DomainKitPorts): IntelligenceProducer<C> {
  return {
    id: spec.id,
    domain: spec.domain,
    scope: spec.scope,
    subjectKinds: spec.subjectKinds ?? ['DOMAIN'],
    kind: spec.model ? 'RULE_AND_MODEL' : 'RULE',
    taskId: spec.model?.task.taskId ?? null,
    gather: (target, now) => spec.gather(target, now),
    readingIdentity: () => identityOf(spec, ports),
    ...(spec.discover ? { discover: (now: Date) => spec.discover!(now) } : {}),
    async read(target, ctx, fingerprint, now): Promise<IntelligenceReadResult> {
      const rule = spec.rule(ctx, now);
      let statement = rule.statement;
      let status = rule.status;
      let confidence = rule.confidence;
      let signals: IntelligenceSignal[] = [...rule.signals];
      let producerKind: 'RULE' | 'RULE_AND_MODEL' = 'RULE';
      let aiInvocationId: string | null = null;
      let taskVersion: string | null = null;
      let modelStage: string | undefined;
      const limitations = [...rule.limitations];
      if (spec.model && !(ports.reader && ports.modelEnabled(spec.model.task.taskId))) modelStage = 'MODEL_NOT_ACTIVATED';
      if (spec.model && ports.reader && ports.modelEnabled(spec.model.task.taskId)) {
        const principal = await ports.principalFor(target);
        const built = spec.model.context(ctx, rule);
        if (!principal) modelStage = 'NO_PRINCIPAL';
        else if (built.items.length === 0) modelStage = 'EMPTY_CONTEXT';
        if (principal && built.items.length > 0) {
          // Every block is minted INSIDE the organization it is read in (`<org>::<id>`), which the gateway's
          // context validation requires: without it every call was refused before any reservation.
          const org = principal.organizationId;
          const items = built.items.map((i) => (i.blockId.startsWith(`${org}::`) ? i : { ...i, blockId: `${org}::${i.blockId}` }));
          const context = { organizationId: org, viewerUserId: principal.userId, taskId: spec.model.task.taskId, items, sensitivityCeiling: spec.model.task.sensitivityCeiling };
          // Checked here too, so a refusal is named (the gateway reports only CONTEXT_REFUSED) and costs nothing.
          const contextRefusals = validateAiContextPackage(context);
          // The backoffs: after a rejected answer (a day), and after a failed provider call (hours). Unreadable: no
          // call now (fail closed), tried again next pass.
          const ask = (since: number) => ({
            organizationId: target.organizationId,
            userId: target.scope === 'PRINCIPAL' ? target.userId : null,
            taskId: spec.model!.task.taskId,
            taskVersion: spec.model!.task.version,
            templateVersion: DOMAIN_READING_TEMPLATE_VERSION,
            since: new Date(now.getTime() - since),
          });
          const backoff =
            contextRefusals.length > 0 || !ports.modelRejectedSince
              ? false
              : await ports.modelRejectedSince(ask(MODEL_REJECTION_BACKOFF_MS)).catch(() => null);
          const failedBackoff =
            contextRefusals.length > 0 || backoff !== false || !ports.modelFailedSince ? false : await ports.modelFailedSince(ask(MODEL_FAILURE_BACKOFF_MS)).catch(() => null);
          const answer =
            contextRefusals.length > 0
              ? ({ outcome: 'CONTEXT_REFUSED', codes: contextRefusals } as const)
              : backoff === null || failedBackoff === null
                ? ({ outcome: 'FAILED', failure: 'BACKOFF_UNREADABLE' } as const)
                : backoff
                  ? ({ outcome: 'MODEL_BACKOFF' } as const)
                  : failedBackoff
                    ? ({ outcome: 'MODEL_BACKOFF_FAILED' } as const)
                    : await ports.reader.read(principal, { task: spec.model.task, framing: spec.model.framing, context, evidence: built.evidence });
          modelStage = modelStageCode(answer);
          // The merged reading must be one Loop can store: checked HERE, against the same contract the digest
          // write applies, so an answer that validated alone but cannot merge (two long keys that collide once
          // prefixed and cut to 64) never costs the rule reading its write. It is then discarded, whole.
          const merged =
            answer.outcome === 'READ'
              ? mergeModelReading(signals, answer.reading.signals, spec.scope)
              : null;
          if (answer.outcome === 'READ' && merged && merged.refusals.length > 0) {
            modelStage = `REJECTED_OUTPUT:MERGE_${merged.refusals[0]}`.slice(0, 96);
            limitations.push('This is Loop’s rule-based reading; the model reading could not be combined with it.');
          } else if (answer.outcome === 'READ' && merged) {
            statement = answer.reading.reading.statement;
            status = answer.reading.reading.status;
            confidence = answer.reading.reading.confidence;
            // The rule's MEASURED and OBSERVED facts stay; the model's readings join them, keyed apart.
            signals = merged.signals;
            limitations.push(...answer.reading.limitations);
            producerKind = 'RULE_AND_MODEL';
            aiInvocationId = answer.provenance.invocationId;
            taskVersion = answer.provenance.taskVersion;
          } else {
            limitations.push('This is Loop’s rule-based reading; the model reading was not available this time.');
          }
        }
      }
      const digest: IntelligenceDigestInput = {
        scope: spec.scope,
        domain: spec.domain,
        subjectKind: target.subjectKind,
        subjectRef: target.subjectKind === 'DOMAIN' ? INTELLIGENCE_DOMAIN_SUBJECT_REF : target.subjectRef,
        provider: spec.provider,
        consentBasis: spec.consentBasis,
        content: {
          synthesis: statement,
          confidence,
          limitations: limitations.map((l) => l.trim()).filter(Boolean).slice(0, 8),
          reading: { statement, status, confidence },
          signals: signals.slice(0, MAX_SIGNALS),
        },
        coverage: rule.coverage,
        windowStart: rule.windowStart,
        windowEnd: rule.windowEnd,
        evidenceCount: rule.evidenceCount,
        lastEvidenceAt: rule.lastEvidenceAt,
        provenance: {
          sourceRefs: rule.sourceRefs.slice(0, 64),
          producerVersion: `${spec.id}#${spec.version}`,
          producerKind,
          sources: rule.sources,
          // How the model stage went (a bounded code) and how this producer reads: what proves, without any
          // content, whether a reading is the model's and why not when it is not.
          ...(spec.model ? { modelStage: modelStage ?? 'MODEL_NOT_ACTIVATED', readingIdentity: identityOf(spec, ports) } : {}),
          ...(aiInvocationId ? { aiInvocationId, taskId: spec.model!.task.taskId, taskVersion, schemaId: 'domain-reading.v1' } : {}),
        },
        aiInvocationId,
        entityRefs: rule.entityRefs.slice(0, 32),
        fingerprint,
        generatedAt: now,
      };
      return { status: 'READ', digest, ...(modelStage ? { modelStage } : {}) };
    },
  };
}

const CODE = /^[A-Z][A-Z0-9_]{0,47}$/;
const safe = (c: unknown) => (typeof c === 'string' && CODE.test(c) ? c : 'OTHER');

/** A bounded, content-free code for how a model stage went. Never an id, a subject, content or provider text. */
export function modelStageCode(answer: { readonly outcome: string; readonly codes?: readonly string[]; readonly failure?: string }): string {
  switch (answer.outcome) {
    case 'READ':
      return 'MODEL_READ';
    case 'CONTEXT_REFUSED':
      return `CONTEXT_REFUSED:${[...new Set((answer.codes ?? []).map(safe))].sort().slice(0, 4).join('+')}`;
    case 'REFUSED_BY_LOOP':
      return `REFUSED_BY_LOOP:${[...new Set((answer.codes ?? []).map(safe))].sort().slice(0, 4).join('+')}`;
    case 'REJECTED_OUTPUT':
      // Which contract rules the answer broke (codes only, never the answer): what production could not see.
      return `REJECTED_OUTPUT:${[...new Set((answer.codes ?? []).map(safe))].sort().slice(0, 4).join('+')}`;
    case 'REFUSED_BY_MODEL':
      return 'REFUSED_BY_MODEL';
    case 'MODEL_BACKOFF':
      return 'MODEL_BACKOFF:REJECTED_OUTPUT';
    case 'MODEL_BACKOFF_FAILED':
      return 'MODEL_BACKOFF:FAILED';
    case 'FAILED':
      return `FAILED:${safe(answer.failure)}`;
    default:
      return 'OTHER';
  }
}
