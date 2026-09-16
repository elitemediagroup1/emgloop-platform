// Case Explanation: the first AI feature, end to end below the web layer. Slice AI-5.
//
// READ-ONLY, ON DEMAND, CITATION-BOUND. It explains an existing Case. It establishes
// no identity, creates no Fact, Relationship or Participant, touches no Intake
// Record, creates or approves no Decision, executes no Work, contacts nobody,
// modifies no Case, and writes nothing to Commercial Intelligence. Its only writes
// are the usage ledger's rows (through the gateway) and one audit entry per attempt
// that reached a provider -- neither of which carries a prompt or an answer.
//
// THE ORDER: authorize, then read, then run. A person who may not invoke the task is
// refused before the Case is read, so the refusal reveals nothing about the Case --
// not even whether it exists.
//
// ORGANIZATION FROM THE PRINCIPAL, which the web layer takes from the signed session.
// A Case in another organization is NOT_FOUND, indistinguishable from none at all.
//
// AN ANSWER IS SHOWN ONLY WHOLE. The gateway refuses an answer that breaks its
// contract; this service passes that refusal through as a state, never a partial
// answer.

import type { PrismaClient } from '@prisma/client';
import { AI_TASK_CASE_EXPLANATION, type AiAdmissionRefusal, type AiInvocationProvenance, type AiOutputRejection, type AiTaskOutput } from '@emgloop/shared';

import { AuditRepository } from '../../repositories/audit.repository';
import { CaseWorkspaceService } from '../case-workspace.service';
import {
  buildCaseExplanationContext,
  type CaseContextManifestEntry,
  type CaseContextWithheld,
  type CaseExplanationSource,
} from './case-explanation-context';
import type { AiAuthorizer, AiPrincipal, AiRunRequest, AiRunResult } from './gateway';
import {
  CASE_EXPLANATION_SCHEMA,
  CASE_EXPLANATION_TEMPLATE_ID,
  CASE_EXPLANATION_TEMPLATE_VERSION,
  renderCaseExplanationInstructions,
} from './templates/case-explanation';

/** What the service needs of the gateway. Production: AiRuntimeGateway. */
export interface CaseExplanationRuntime {
  run(principal: AiPrincipal, request: AiRunRequest): Promise<AiRunResult>;
}

export interface CaseExplanationDeps {
  readonly runtime: CaseExplanationRuntime;
  readonly authorize: AiAuthorizer;
  readonly cases?: CaseExplanationSource;
  readonly audit?: Pick<AuditRepository, 'record'>;
  readonly now?: () => Date;
}

/** Provenance a screen may show: ids, versions and counts. Never content. */
export interface CaseExplanationProvenance {
  readonly invocationId: string;
  readonly taskVersion: string;
  readonly templateVersion: string;
  readonly routingPolicyVersion: string;
  readonly requestedModel: { readonly providerId: string; readonly modelId: string };
  readonly servedModel: string | null;
  readonly calls: number;
  readonly recordedAt: string;
}

interface Disclosed {
  readonly manifest: readonly CaseContextManifestEntry[];
  readonly withheld: Readonly<Partial<Record<CaseContextWithheld, number>>>;
  readonly entityAliases: Readonly<Record<string, { readonly entityType: string | null; readonly entityName: string | null }>>;
}

export type CaseExplanationResult =
  | ({ readonly outcome: 'ANSWERED'; readonly explanation: AiTaskOutput; readonly provenance: CaseExplanationProvenance } & Disclosed)
  | { readonly outcome: 'NOT_AUTHORIZED' }
  | { readonly outcome: 'NOT_FOUND' }
  | ({ readonly outcome: 'REFUSED_BY_LOOP'; readonly refusals: readonly AiAdmissionRefusal[] } & Disclosed)
  | ({ readonly outcome: 'REJECTED_OUTPUT'; readonly rejections: readonly AiOutputRejection[]; readonly provenance: CaseExplanationProvenance } & Disclosed)
  | ({ readonly outcome: 'REFUSED_BY_MODEL'; readonly provenance: CaseExplanationProvenance } & Disclosed)
  | ({ readonly outcome: 'FAILED'; readonly failure: string; readonly provenance: CaseExplanationProvenance } & Disclosed);

function shown(p: AiInvocationProvenance): CaseExplanationProvenance {
  return {
    invocationId: p.invocationId,
    taskVersion: p.taskVersion,
    templateVersion: p.templateVersion,
    routingPolicyVersion: p.routingPolicyVersion,
    requestedModel: { providerId: p.requestedModel.providerId, modelId: p.requestedModel.modelId },
    servedModel: p.servedModel,
    calls: p.calls,
    recordedAt: p.recordedAt,
  };
}

export class CaseExplanationService {
  private readonly cases: CaseExplanationSource;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly now: () => Date;

  constructor(
    prisma: PrismaClient,
    private readonly deps: CaseExplanationDeps,
  ) {
    this.cases = deps.cases ?? new CaseWorkspaceService(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether this person may invoke Case Explanation. The same question `explain` asks first. */
  async mayInvoke(principal: AiPrincipal): Promise<boolean> {
    try {
      return await this.deps.authorize(principal, AI_TASK_CASE_EXPLANATION);
    } catch {
      return false;
    }
  }

  async explain(principal: AiPrincipal, caseId: string, options: { actorName?: string | null; signal?: AbortSignal } = {}): Promise<CaseExplanationResult> {
    const task = AI_TASK_CASE_EXPLANATION;
    if (!(await this.mayInvoke(principal))) return { outcome: 'NOT_AUTHORIZED' };

    const context = await buildCaseExplanationContext(this.cases, principal, caseId, this.now());
    if (!context) return { outcome: 'NOT_FOUND' };
    const disclosed: Disclosed = { manifest: context.manifest, withheld: context.withheld, entityAliases: context.entityAliases };

    const result = await this.deps.runtime.run(principal, {
      task,
      context: context.package,
      instructions: renderCaseExplanationInstructions(context.package.items.map((i) => i.sourceRef)),
      templateId: CASE_EXPLANATION_TEMPLATE_ID,
      templateVersion: CASE_EXPLANATION_TEMPLATE_VERSION,
      schema: CASE_EXPLANATION_SCHEMA,
      evidence: context.evidence,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (result.outcome === 'REFUSED_BY_LOOP') {
      // Nothing reached a provider. The gateway's refusal is the whole record.
      if (result.refusals.includes('NOT_AUTHORIZED')) return { outcome: 'NOT_AUTHORIZED' };
      return { outcome: 'REFUSED_BY_LOOP', refusals: result.refusals, ...disclosed };
    }

    // A provider was called. The trail records that it happened, by whom, and how it
    // ended -- ids, versions and counts only.
    await this.audit.record({
      organizationId: principal.organizationId,
      userId: principal.userId,
      actorName: options.actorName?.trim() || undefined,
      action: 'ai.case_explanation',
      entityType: 'case',
      entityId: caseId,
      metadata: {
        invocationId: result.provenance.invocationId,
        taskId: task.taskId,
        taskVersion: result.provenance.taskVersion,
        templateVersion: result.provenance.templateVersion,
        routingPolicyVersion: result.provenance.routingPolicyVersion,
        outcome: result.outcome,
        calls: result.provenance.calls,
        servedModel: result.provenance.servedModel,
        ...(result.outcome === 'REJECTED_OUTPUT' ? { rejections: [...result.rejections] } : {}),
        ...(result.outcome === 'FAILED' ? { failure: result.failure } : {}),
      },
    });

    const provenance = shown(result.provenance);
    switch (result.outcome) {
      case 'ANSWERED':
        return { outcome: 'ANSWERED', explanation: result.output, provenance, ...disclosed };
      case 'REJECTED_OUTPUT':
        return { outcome: 'REJECTED_OUTPUT', rejections: result.rejections, provenance, ...disclosed };
      case 'REFUSED_BY_MODEL':
        return { outcome: 'REFUSED_BY_MODEL', provenance, ...disclosed };
      default:
        return { outcome: 'FAILED', failure: result.failure, provenance, ...disclosed };
    }
  }
}
