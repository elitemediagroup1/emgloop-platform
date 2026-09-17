// What Loop answers a Brain executor, and on whose authority. Slice B5.
//
// Architecture: docs/architecture/brain-boundary.md §6, brain-execution-infrastructure.md
// §5.3 and §12.
//
// THREE QUESTIONS, NO MORE. An executor may ask Loop:
//   ACCESS_DECISION  may this job's principal still do this work, right now?
//   CONTEXT          what is the minimized, authorized context this task may see?
//   COMMIT_RESULT    here is a candidate result -- will its owner accept it?
// Everything else an executor does is its own state (`BrainExecutorStore`). There is no
// general query, no product read by id, no write outside an owner's gate.
//
// THE JOB IS THE AUTHORITY. The caller has already verified the executor's token and
// loaded the job the token names (`brainWorkerRequestCheck`). Every answer here is
// decided from THAT job: its organization, its principal, its task, its subject. Nothing
// the executor sends can name another.
//
// RE-DECIDED EVERY TIME. Access is decided from membership and permissions at the moment
// of the call, never at submission. Context is re-assembled under that decision. A commit
// re-assembles the evidence Loop supplied and checks every citation against it, so an
// executor can neither invent evidence nor keep citing something that is no longer there.
//
// RESULTS BELONG TO THEIR OWNERS. A commit reaches the owning authority's gate, which
// stores the artifact and returns its id. When no gate exists for a kind of result, the
// commit is refused; Brain never stores the result itself, and Activity never holds it.

import type { PrismaClient } from '@prisma/client';
import {
  AI_TASKS,
  brainCommitExpectation,
  brainCommitRefusals,
  brainResultCommitKey,
  validateAiContextPackage,
  type AiContextPackage,
  type AiTaskDefinition,
  type BrainAccessDecision,
  type BrainCommitRefusal,
  type BrainJobSnapshot,
  type BrainPrincipalRecord,
  type BrainResultEnvelope,
  type BrainResultRef,
  type BrainSuppliedEvidence,
} from '@emgloop/shared';

import { membershipAuthority } from '../../repositories/membership.repository';
import type { BrainTaskInput } from '../../repositories/brain/brain-records';
import type { AiAuthorizer } from '../ai-runtime/gateway';
import { buildCaseExplanationContext } from '../ai-runtime/case-explanation-context';
import { CaseWorkspaceService } from '../case-workspace.service';

/** The minimized context a task may see, as Loop assembled it just now. */
export interface BrainTaskContext {
  readonly package: AiContextPackage;
  /** Every ref the context offered, with how far it can be trusted. The only citable set. */
  readonly supplied: readonly BrainSuppliedEvidence[];
  /** Task-specific support the executor's validator needs (e.g. figures and dates). */
  readonly support: Readonly<Record<string, unknown>>;
  /** What was held back, as counts. Never content. */
  readonly withheld: Readonly<Record<string, number>>;
}

/** Builds one task's context for one job. Registered per task id; none means refused. */
export type BrainContextAssembler = (request: {
  readonly job: BrainJobSnapshot;
  readonly input: BrainTaskInput;
  readonly task: AiTaskDefinition;
  readonly now: Date;
}) => Promise<BrainTaskContext | null>;

/** An owning authority's gate for one kind of result about one kind of subject. */
export interface BrainResultOwnerGate {
  readonly resultType: string;
  readonly authority: string;
  readonly subjectType: string;
  /**
   * Store the artifact, idempotently by `commitKey`, and return its id. The owner decides
   * whether to accept it; a refusal is returned, never thrown.
   */
  commit(request: {
    readonly organizationId: string;
    readonly job: BrainJobSnapshot;
    readonly envelope: BrainResultEnvelope;
    readonly commitKey: string;
  }): Promise<{ readonly ok: true; readonly artifactId: string } | { readonly ok: false; readonly reason: string }>;
}

export interface BrainInternalDeps {
  readonly authorize: AiAuthorizer;
  readonly tasks?: readonly AiTaskDefinition[];
  readonly contexts?: Readonly<Record<string, BrainContextAssembler>>;
  readonly owners?: readonly BrainResultOwnerGate[];
  readonly readInput: (organizationId: string, jobId: string) => Promise<BrainTaskInput | null>;
  readonly now?: () => Date;
}

export interface BrainAccessAnswer {
  readonly principal: BrainPrincipalRecord | null;
  readonly decision: BrainAccessDecision;
}

/**
 * Whether a result of this job could be handed to its owner at all. An executor reads it
 * before any paid step: work whose result has nowhere to land is not worth paying for.
 */
export type BrainCommitGateState = 'AVAILABLE' | 'UNAVAILABLE';

export type BrainContextAnswer =
  | { readonly ok: true; readonly context: BrainTaskContext; readonly access: BrainAccessAnswer; readonly commitGate: BrainCommitGateState }
  | { readonly ok: false; readonly refusal: 'NOT_PERMITTED' | 'NO_CONTEXT_FOR_TASK' | 'CONTEXT_UNAVAILABLE' | 'CONTEXT_REFUSED' };

export type BrainCommitAnswer =
  | { readonly ok: true; readonly ref: BrainResultRef; readonly commitKey: string }
  | {
      readonly ok: false;
      readonly refusal: 'NOT_PERMITTED' | 'OWNER_GATE_UNAVAILABLE' | 'OWNER_REFUSED' | 'CONTEXT_UNAVAILABLE' | 'COMMIT_REFUSED';
      readonly details: readonly (BrainCommitRefusal | string)[];
    };

export class BrainInternalService {
  private readonly tasks: readonly AiTaskDefinition[];
  private readonly contexts: Readonly<Record<string, BrainContextAssembler>>;
  private readonly owners: readonly BrainResultOwnerGate[];
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly deps: BrainInternalDeps,
  ) {
    this.tasks = deps.tasks ?? AI_TASKS;
    this.contexts = deps.contexts ?? defaultBrainContextAssemblers(prisma);
    this.owners = deps.owners ?? [];
    this.now = deps.now ?? (() => new Date());
  }

  private task(job: BrainJobSnapshot): AiTaskDefinition | null {
    return this.tasks.find((t) => t.taskId === job.taskId && t.version === job.taskVersion) ?? null;
  }

  /**
   * Whether the job's principal may do this work now. The executor applies
   * `brainBoundaryRefusals` to the answer; so does every other method here.
   */
  async access(job: BrainJobSnapshot): Promise<BrainAccessAnswer> {
    const now = this.now();
    const authority = await membershipAuthority(this.prisma, job.organizationId, job.principalUserId).catch(() => null);
    const principal: BrainPrincipalRecord | null = authority
      ? {
          userId: job.principalUserId,
          organizationId: job.organizationId,
          kind: authority.granted && authority.systemRole === 'AI_EMPLOYEE' ? 'AI_EMPLOYEE' : 'HUMAN',
          membershipActive: authority.granted === true,
        }
      : null;
    const task = this.task(job);
    let allowed = false;
    if (task && principal?.membershipActive) {
      try {
        allowed = (await this.deps.authorize({ organizationId: job.organizationId, userId: job.principalUserId }, task)) === true;
      } catch {
        allowed = false;
      }
    }
    return {
      principal,
      decision: { allowed, organizationId: job.organizationId, principalUserId: job.principalUserId, taskId: job.taskId, decidedAtMs: now.getTime() },
    };
  }

  /** The minimized context for this job's task, assembled under a fresh access decision. */
  async context(job: BrainJobSnapshot): Promise<BrainContextAnswer> {
    const access = await this.access(job);
    if (!access.decision.allowed) return { ok: false, refusal: 'NOT_PERMITTED' };
    const task = this.task(job);
    const assemble = task ? this.contexts[task.taskId] : undefined;
    if (!task || !assemble) return { ok: false, refusal: 'NO_CONTEXT_FOR_TASK' };
    const input = await this.deps.readInput(job.organizationId, job.jobId);
    if (!input) return { ok: false, refusal: 'CONTEXT_UNAVAILABLE' };
    const context = await assemble({ job, input, task, now: this.now() }).catch(() => null);
    if (!context) return { ok: false, refusal: 'CONTEXT_UNAVAILABLE' };
    if (context.package.organizationId !== job.organizationId || context.package.viewerUserId !== job.principalUserId) {
      return { ok: false, refusal: 'CONTEXT_REFUSED' };
    }
    if (validateAiContextPackage(context.package).length > 0) return { ok: false, refusal: 'CONTEXT_REFUSED' };
    return { ok: true, context, access, commitGate: ownerGateFor(this.owners, job) ? 'AVAILABLE' : 'UNAVAILABLE' };
  }

  /**
   * Hand a candidate result to its owner. The expectation comes from the job alone; the
   * citable evidence is re-assembled now; the owner's gate decides and stores.
   */
  async commit(job: BrainJobSnapshot, stepKey: string, envelope: BrainResultEnvelope): Promise<BrainCommitAnswer> {
    const context = await this.context(job);
    if (!context.ok) {
      return {
        ok: false,
        refusal: context.refusal === 'NOT_PERMITTED' ? 'NOT_PERMITTED' : 'CONTEXT_UNAVAILABLE',
        details: [context.refusal],
      };
    }
    const refusals = brainCommitRefusals(envelope, brainCommitExpectation(job), context.context.supplied);
    if (refusals.length > 0) return { ok: false, refusal: 'COMMIT_REFUSED', details: refusals };
    const gate =
      envelope.resultType === job.resultType &&
      envelope.owner.authority === job.resultOwner.authority &&
      envelope.owner.subjectType === job.resultOwner.subjectType
        ? ownerGateFor(this.owners, job)
        : null;
    if (!gate) return { ok: false, refusal: 'OWNER_GATE_UNAVAILABLE', details: [`${envelope.resultType}:${envelope.owner.authority}`] };
    const commitKey = brainResultCommitKey(job.jobId, stepKey);
    const stored = await gate.commit({ organizationId: job.organizationId, job, envelope, commitKey });
    if (!stored.ok) return { ok: false, refusal: 'OWNER_REFUSED', details: [stored.reason] };
    return {
      ok: true,
      commitKey,
      ref: { owner: { authority: envelope.owner.authority, subjectType: envelope.owner.subjectType }, subjectId: job.subject.id, artifactId: stored.artifactId },
    };
  }
}

/** The owning authority's gate for what this job produces, if one is registered. */
function ownerGateFor(owners: readonly BrainResultOwnerGate[], job: BrainJobSnapshot): BrainResultOwnerGate | null {
  return (
    owners.find((g) => g.resultType === job.resultType && g.authority === job.resultOwner.authority && g.subjectType === job.resultOwner.subjectType) ??
    null
  );
}

/**
 * The tasks whose context Loop can assemble for an executor today. Case Explanation
 * reuses the exact minimized context the interactive path already sends: structured
 * measurements and system findings, with every free-text field, name and user identifier
 * withheld.
 */
export function defaultBrainContextAssemblers(prisma: PrismaClient): Readonly<Record<string, BrainContextAssembler>> {
  const cases = new CaseWorkspaceService(prisma);
  return Object.freeze({
    'case.explanation': async ({ job, now }) => {
      if (job.subject.type !== 'CASE') return null;
      const built = await buildCaseExplanationContext(
        cases,
        { organizationId: job.organizationId, userId: job.principalUserId },
        job.subject.id,
        now,
      );
      if (!built) return null;
      return {
        package: built.package,
        supplied: built.package.items.map((item) => ({ ref: item.sourceRef, trust: item.trust })),
        support: {
          figures: Object.fromEntries([...built.evidence.figures].map(([ref, set]) => [ref, [...set]])),
          dates: [...built.evidence.dates],
        },
        withheld: { ...built.withheld } as Record<string, number>,
      };
    },
  });
}
