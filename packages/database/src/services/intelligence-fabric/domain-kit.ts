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
import type { DomainReadingFraming } from '../ai-runtime/templates/domain-reading';
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
}

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
      const limitations = [...rule.limitations];
      if (spec.model && ports.reader && ports.modelEnabled(spec.model.task.taskId)) {
        const principal = await ports.principalFor(target);
        const built = spec.model.context(ctx, rule);
        if (principal && built.items.length > 0) {
          const answer = await ports.reader.read(principal, {
            task: spec.model.task,
            framing: spec.model.framing,
            context: { organizationId: principal.organizationId, viewerUserId: principal.userId, taskId: spec.model.task.taskId, items: [...built.items], sensitivityCeiling: spec.model.task.sensitivityCeiling },
            evidence: built.evidence,
          });
          if (answer.outcome === 'READ') {
            statement = answer.reading.reading.statement;
            status = answer.reading.reading.status;
            confidence = answer.reading.reading.confidence;
            // The rule's MEASURED and OBSERVED facts stay; the model's readings join them, keyed apart.
            const ruleKeys = new Set(signals.map((s) => s.key));
            signals = [...signals, ...answer.reading.signals.filter((s) => !ruleKeys.has(`m.${s.key}`)).map((s) => ({ ...s, key: `m.${s.key}`.slice(0, 64) }))];
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
          ...(aiInvocationId ? { aiInvocationId, taskId: spec.model!.task.taskId, taskVersion, schemaId: 'domain-reading.v1' } : {}),
        },
        aiInvocationId,
        entityRefs: rule.entityRefs.slice(0, 32),
        fingerprint,
        generatedAt: now,
      };
      return { status: 'READ', digest };
    },
  };
}
