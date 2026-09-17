// The Brain boundary a signed-in person reaches: submit, status, answer, cancel. Slice B5.
//
// Architecture: docs/architecture/brain-boundary.md §2-§5.
//
// THE PERSON AND THE ORGANIZATION COME FROM THE SESSION. The caller hands over a
// principal it resolved from the signed session; nothing in a request body can name an
// organization, a person or a role, and `parseBrainSubmission` refuses one that tries.
//
// AUTHORIZE BEFORE READING. Whether this person may start this task is decided first
// (membership, role, the task's permissions -- `iamAiAuthorizer`). Only then are the
// recorded controls, the routing policy and the subject itself consulted. Somebody who
// may not start a task learns only that.
//
// ACCEPTING IS NOT RUNNING. A submission becomes a job, its history, its event and a
// START command in Neon. The doorbell is then rung so an executor looks at the stored
// command; if the ring is lost or not configured, the job is still safely recorded and
// the executor's sweeper finds it. Nothing here calls a model, a provider or an
// execution environment, and nothing here needs a credential for one.
//
// A STATUS IS A RECORD, NOT A CONNECTION. Any page can ask later what a job is doing;
// the answer is read from Neon and never depends on the browser that submitted it.
//
// NO PROVIDER, NO MODEL, NO ATTEMPT DRAMA. The views here carry a job's state, its
// named step, and where its results live. Which provider or model served a call belongs
// to provenance and diagnostic surfaces, not to this boundary.

import type { PrismaClient } from '@prisma/client';
import {
  AI_TASKS,
  BRAIN_QUESTION_SCHEMA_ID,
  BRAIN_QUESTION_SCHEMA_VERSION,
  aiEffectiveControls,
  aiTaskAvailability,
  brainJobIsTerminal,
  brainRouteGate,
  brainSubmissionRefusals,
  measuredList,
  parseBrainQuestion,
  parseBrainQuestionReply,
  parseBrainSubmission,
  type AiControlFloor,
  type AiProviderSpecializationPolicy,
  type AiRoutingPolicy,
  type AiTaskDefinition,
  type BrainExecutionClass,
  type BrainJobSnapshot,
  type BrainJobState,
  type BrainQuestion,
  type BrainResultSubjectType,
  type BrainResultType,
  type Truth,
} from '@emgloop/shared';

import { membershipAuthority } from '../../repositories/membership.repository';
import { AiControlRepository } from '../../repositories/brain/ai-control.repository';
import { BrainJobRepository, type BrainJobRecord } from '../../repositories/brain/brain-job.repository';
import { BrainStepRepository } from '../../repositories/brain/brain-step.repository';
import { BrainWaitRepository } from '../../repositories/brain/brain-wait.repository';
import type { AiAuthorizer } from '../ai-runtime/gateway';
import { PrismaBrainSubjectResolver, brainSubjectHref, type BrainSubjectResolver } from './brain-subjects';

/** The signed-in person, as the session resolved them. */
export interface BrainWorkPrincipal {
  readonly organizationId: string;
  readonly userId: string;
}

/** What ringing the doorbell achieved. Never a reason to refuse or undo a submission. */
export type BrainDoorbellOutcome = 'RUNG' | 'NOT_CONFIGURED' | 'FAILED';

export interface BrainWorkDeps {
  readonly authorize: AiAuthorizer;
  /** This deployment's environment floor. Read per call, never stored. */
  readonly controlFloor: () => AiControlFloor;
  readonly routing: AiRoutingPolicy;
  readonly specialization: AiProviderSpecializationPolicy;
  readonly tasks?: readonly AiTaskDefinition[];
  readonly ring?: (commandId: string) => Promise<BrainDoorbellOutcome>;
  readonly subjects?: BrainSubjectResolver;
  readonly now?: () => Date;
}

/** The product-level phase of a job. Provider-neutral by construction. */
export const BRAIN_WORK_PHASES = ['QUEUED', 'WORKING', 'WAITING_FOR_YOU', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type BrainWorkPhase = (typeof BRAIN_WORK_PHASES)[number];

export function brainWorkPhase(state: BrainJobState): BrainWorkPhase {
  switch (state) {
    case 'ACCEPTED':
    case 'QUEUED':
      return 'QUEUED';
    case 'RUNNING':
      return 'WORKING';
    case 'WAITING_FOR_USER':
      return 'WAITING_FOR_YOU';
    case 'SUCCEEDED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
  }
}

export interface BrainResultLocation {
  readonly authority: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly artifactId: string;
  /** The owner's page. The result is read there, under the owner's guard. */
  readonly href: string | null;
}

/** What a person may see about their own Brain work. */
export interface BrainWorkView {
  readonly jobId: string;
  readonly taskId: string;
  readonly resultType: BrainResultType;
  readonly subject: { readonly type: BrainResultSubjectType; readonly id: string; readonly href: string | null };
  readonly executionClass: BrainExecutionClass;
  readonly promoted: boolean;
  readonly state: BrainJobState;
  readonly phase: BrainWorkPhase;
  readonly finished: boolean;
  readonly waiting: { readonly waitId: string; readonly expiresAt: string } | null;
  readonly cancelRequested: boolean;
  readonly endReason: string | null;
  readonly results: readonly BrainResultLocation[];
  /** The step being worked on, and how many have finished. Never a percentage. */
  readonly progress: { readonly currentStep: { readonly key: string; readonly kind: string } | null; readonly completedSteps: number };
  readonly acceptedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export const BRAIN_SUBMIT_REFUSALS = [
  'INVALID_SUBMISSION',
  'NOT_PERMITTED',
  'UNKNOWN_TASK',
  'EXECUTION_CLASS_NOT_SUPPORTED',
  'SUBJECT_TYPE_MISMATCH',
  'NOT_ENABLED',
  'PAUSED',
  'NOT_CONFIGURED',
  'ROUTING_NOT_CONFORMANT',
  'SUBJECT_NOT_FOUND',
  'OWNERSHIP_NOT_PERMITTED',
  'UNKNOWN_CAPABILITY_ROUTE',
  'PRINCIPAL_NOT_ACTIVE_MEMBER',
  'RESUMED_JOB_NOT_RESUMABLE',
  'IDEMPOTENCY_KEY_REUSED',
] as const;
export type BrainSubmitRefusal = (typeof BRAIN_SUBMIT_REFUSALS)[number];

export type BrainSubmitOutcome =
  | { readonly kind: 'ACCEPTED'; readonly work: BrainWorkView; readonly dispatch: BrainDoorbellOutcome }
  | { readonly kind: 'EXISTING'; readonly work: BrainWorkView }
  | { readonly kind: 'REFUSED'; readonly refusal: BrainSubmitRefusal };

export interface BrainQuestionView {
  readonly waitId: string;
  readonly jobId: string;
  readonly status: string;
  readonly question: BrainQuestion;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly answeredAt: string | null;
}

export type BrainRespondOutcome =
  | { readonly ok: true; readonly recorded: 'NOW' | 'ALREADY'; readonly dispatch: BrainDoorbellOutcome }
  | {
      readonly ok: false;
      readonly refusal:
        | 'WAIT_NOT_FOUND'
        | 'NOT_PERMITTED'
        | 'QUESTION_UNREADABLE'
        | 'INVALID_REPLY'
        | 'WAIT_MISMATCH'
        | 'RESPONDER_IS_NOT_PRINCIPAL'
        | 'WAIT_ALREADY_ANSWERED'
        | 'WAIT_EXPIRED'
        | 'WAIT_CLOSED'
        | 'REPLY_CONFLICT';
    };

export type BrainCancelWorkOutcome =
  | { readonly ok: true; readonly work: BrainWorkView; readonly stoppedNow: boolean; readonly dispatch: BrainDoorbellOutcome }
  | { readonly ok: false; readonly refusal: 'JOB_NOT_FOUND' | 'ALREADY_FINISHED' | 'CONFLICT' };

/** Jobs about one subject, as anyone allowed to run their task may see them. States only. */
export interface BrainSubjectWorkItem {
  readonly jobId: string;
  readonly taskId: string;
  readonly resultType: BrainResultType;
  readonly phase: BrainWorkPhase;
  readonly startedByUserId: string;
}

const ADMINISTRATOR_ROLES = ['OWNER', 'ADMIN'];
const MAX_LIST = 50;

export class BrainWorkService {
  private readonly jobs: BrainJobRepository;
  private readonly waits: BrainWaitRepository;
  private readonly steps: BrainStepRepository;
  private readonly controls: AiControlRepository;
  private readonly subjects: BrainSubjectResolver;
  private readonly tasks: readonly AiTaskDefinition[];
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly deps: BrainWorkDeps,
  ) {
    this.jobs = new BrainJobRepository(prisma);
    this.waits = new BrainWaitRepository(prisma);
    this.steps = new BrainStepRepository(prisma);
    this.controls = new AiControlRepository(prisma);
    this.subjects = deps.subjects ?? new PrismaBrainSubjectResolver(prisma);
    this.tasks = deps.tasks ?? AI_TASKS;
    this.now = deps.now ?? (() => new Date());
  }

  private task(taskId: string): AiTaskDefinition | null {
    return this.tasks.find((t) => t.taskId === taskId) ?? null;
  }

  private async mayRun(principal: BrainWorkPrincipal, task: AiTaskDefinition): Promise<boolean> {
    try {
      return (await this.deps.authorize(principal, task)) === true;
    } catch {
      return false;
    }
  }

  private async ring(commandId: string): Promise<BrainDoorbellOutcome> {
    if (!this.deps.ring) return 'NOT_CONFIGURED';
    try {
      return await this.deps.ring(commandId);
    } catch {
      // The command is stored; the sweeper will find it. A lost ring is not a lost job.
      return 'FAILED';
    }
  }

  /** Start Brain work as this person. */
  async submit(principal: BrainWorkPrincipal, raw: unknown): Promise<BrainSubmitOutcome> {
    const parsed = parseBrainSubmission(raw);
    if (!parsed.ok) return refused('INVALID_SUBMISSION');
    const submission = parsed.submission;
    const organizationId = principal.organizationId;

    // 1. Authorization, before anything about the task or its subject is read.
    const authority = await membershipAuthority(this.prisma, organizationId, principal.userId).catch(() => null);
    const membershipActive = authority?.granted === true;
    const role = authority?.granted === true ? authority.systemRole : null;
    const task = this.task(submission.taskId);
    const allowed = task ? await this.mayRun(principal, task) : membershipActive;
    const submitterRefusals = brainSubmissionRefusals(
      task
        ? { taskId: task.taskId, executionClasses: task.execution.classes, subjectType: task.resultOwner.subjectType }
        : null,
      submission,
      {
        organizationId,
        userId: principal.userId,
        kind: role === 'AI_EMPLOYEE' ? 'AI_EMPLOYEE' : 'HUMAN',
        membershipActive,
        allowed,
      },
    );
    if (submitterRefusals.length > 0) return refused(submitterRefusals[0]!);
    if (!task) return refused('UNKNOWN_TASK');

    // 2. Recorded controls on top of this deployment's floor.
    const effective = aiEffectiveControls(this.deps.controlFloor(), await this.controls.currentFor(organizationId), organizationId);
    const availability = aiTaskAvailability({
      authorized: true,
      activation: effective.activation,
      killSwitches: effective.killSwitches,
      policy: this.deps.routing,
      organizationId,
      taskId: task.taskId,
    });
    if (availability !== 'AVAILABLE') {
      return refused(availability === 'PAUSED' ? 'PAUSED' : availability === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'NOT_ENABLED');
    }

    // 3. The reviewed routing must still honour provider specialization.
    const gate = brainRouteGate({ taskId: task.taskId, version: task.version, capabilityRoute: task.capabilityRoute }, this.deps.routing, this.deps.specialization);
    if (!gate.ok) return refused('ROUTING_NOT_CONFORMANT');

    // 4. Only now is the subject read -- in this organization.
    if (!(await this.subjects.exists(organizationId, submission.subject))) return refused('SUBJECT_NOT_FOUND');

    const accepted = await this.jobs.accept(organizationId, {
      principalUserId: principal.userId,
      task: {
        taskId: task.taskId,
        version: task.version,
        capabilityRoute: task.capabilityRoute,
        resultType: task.resultType,
        resultOwner: task.resultOwner,
        executionClasses: task.execution.classes,
      },
      submission,
      now: this.now(),
    });
    if (accepted.kind === 'REFUSED') return refused(accepted.refusal);
    const work = await this.view(organizationId, accepted.job.jobId);
    if (!work) throw new Error('an accepted job could not be read back');
    if (accepted.kind === 'EXISTING') return { kind: 'EXISTING', work };
    return { kind: 'ACCEPTED', work, dispatch: await this.ring(accepted.commandId) };
  }

  /** One of this person's jobs. Another person's job, or another organization's, is not found. */
  async status(principal: BrainWorkPrincipal, jobId: string): Promise<BrainWorkView | null> {
    const view = await this.view(principal.organizationId, jobId);
    return view && (await this.isPrincipal(principal, jobId)) ? view : null;
  }

  /** This person's Brain work: unfinished first, then the most recent. */
  async listMine(principal: BrainWorkPrincipal, options: { readonly limit?: number } = {}): Promise<BrainWorkView[]> {
    const take = Math.min(Math.max(options.limit ?? 20, 1), MAX_LIST);
    const rows = await this.prisma.brainJob.findMany({
      where: { organizationId: principal.organizationId, principalUserId: principal.userId },
      orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, state: true },
    });
    const views = await Promise.all(rows.map((r) => this.view(principal.organizationId, r.id)));
    return views
      .filter((v): v is BrainWorkView => v !== null)
      .sort((a, b) => Number(a.finished) - Number(b.finished));
  }

  /** "Brain - N working": this person's unfinished work, measured. */
  async workingCount(principal: BrainWorkPrincipal): Promise<Truth<number>> {
    return this.jobs.countUnfinishedForPrincipal(principal.organizationId, principal.userId);
  }

  /**
   * Work about one subject, for "Brain is working on this". Only jobs whose task this
   * person may run are shown, and only their state -- never their input, question or result.
   */
  async forSubject(
    principal: BrainWorkPrincipal,
    subject: { readonly type: BrainResultSubjectType; readonly id: string },
  ): Promise<Truth<readonly BrainSubjectWorkItem[]>> {
    const jobs = await this.jobs.listForSubject(principal.organizationId, subject, { unfinishedOnly: true, limit: MAX_LIST });
    const permitted = new Map<string, boolean>();
    const items: BrainSubjectWorkItem[] = [];
    for (const job of jobs) {
      if (!permitted.has(job.taskId)) {
        const task = this.task(job.taskId);
        permitted.set(job.taskId, task ? await this.mayRun(principal, task) : false);
      }
      if (!permitted.get(job.taskId)) continue;
      items.push({ jobId: job.jobId, taskId: job.taskId, resultType: job.resultType, phase: brainWorkPhase(job.state), startedByUserId: job.principalUserId });
    }
    return measuredList(items, { measuredAt: this.now().toISOString(), subject: 'brain.jobs.forSubject' });
  }

  /** The question a job is waiting on, for the one person who may answer it. */
  async question(principal: BrainWorkPrincipal, waitId: string): Promise<BrainQuestionView | null> {
    const view = await this.waits.get(principal.organizationId, waitId);
    if (!view || view.wait.principalUserId !== principal.userId) return null;
    const question = readQuestion(view.question.schemaId, view.question.schemaVersion, view.question.body);
    if (!question) return null;
    return {
      waitId: view.wait.waitId,
      jobId: view.wait.jobId,
      status: view.wait.status,
      question,
      requestedAt: view.requestedAt.toISOString(),
      expiresAt: new Date(view.wait.expiresAtMs).toISOString(),
      answeredAt: view.answeredAt ? view.answeredAt.toISOString() : null,
    };
  }

  /** Answer a waiting job's question. Only its principal can, and only with a valid answer. */
  async respond(principal: BrainWorkPrincipal, waitId: string, rawReply: unknown): Promise<BrainRespondOutcome> {
    const organizationId = principal.organizationId;
    const view = await this.waits.get(organizationId, waitId);
    // Somebody else's question is not found, exactly as `question` and `status` say.
    if (!view || view.wait.principalUserId !== principal.userId) return { ok: false, refusal: 'WAIT_NOT_FOUND' };
    const job = await this.jobs.get(organizationId, view.wait.jobId);
    const task = job ? this.task(job.job.taskId) : null;
    if (!job || !task || !(await this.mayRun(principal, task))) return { ok: false, refusal: 'NOT_PERMITTED' };
    const question = readQuestion(view.question.schemaId, view.question.schemaVersion, view.question.body);
    if (!question) return { ok: false, refusal: 'QUESTION_UNREADABLE' };
    const reply = parseBrainQuestionReply(question, rawReply);
    if (!reply.ok) return { ok: false, refusal: 'INVALID_REPLY' };

    let outcome = await this.waits.answer(organizationId, { waitId, responderUserId: principal.userId, reply: { ...reply.reply }, now: this.now() });
    if (!outcome.ok && outcome.refusal === 'REPLY_CONFLICT') {
      outcome = await this.waits.answer(organizationId, { waitId, responderUserId: principal.userId, reply: { ...reply.reply }, now: this.now() });
    }
    if (!outcome.ok) return { ok: false, refusal: outcome.refusal };
    return { ok: true, recorded: outcome.recorded, dispatch: await this.ring(outcome.commandId) };
  }

  /**
   * Stop a job. Its principal may always ask; an OWNER or ADMIN of the organization may
   * stop anybody's. Anyone else is told the job does not exist.
   */
  async cancel(principal: BrainWorkPrincipal, jobId: string): Promise<BrainCancelWorkOutcome> {
    const organizationId = principal.organizationId;
    const record = await this.jobs.get(organizationId, jobId);
    if (!record) return { ok: false, refusal: 'JOB_NOT_FOUND' };
    let reason: 'REQUESTED_BY_PRINCIPAL' | 'REQUESTED_BY_ADMINISTRATOR';
    if (record.job.principalUserId === principal.userId) reason = 'REQUESTED_BY_PRINCIPAL';
    else if (await this.isAdministrator(principal)) reason = 'REQUESTED_BY_ADMINISTRATOR';
    else return { ok: false, refusal: 'JOB_NOT_FOUND' };
    if (brainJobIsTerminal(record.job.state)) return { ok: false, refusal: 'ALREADY_FINISHED' };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await this.jobs.requestCancel(
        organizationId,
        jobId,
        { actor: { kind: 'HUMAN', userId: principal.userId }, reason },
        { now: this.now() },
      );
      if (outcome.ok) {
        const work = await this.view(organizationId, jobId);
        return { ok: true, work: work!, stoppedNow: outcome.stoppedNow, dispatch: await this.ring(outcome.commandId) };
      }
      if (outcome.refusal === 'JOB_IS_TERMINAL') return { ok: false, refusal: 'ALREADY_FINISHED' };
      if (outcome.refusal === 'JOB_NOT_FOUND') return { ok: false, refusal: 'JOB_NOT_FOUND' };
      if (outcome.refusal !== 'VERSION_CONFLICT') return { ok: false, refusal: 'CONFLICT' };
    }
    return { ok: false, refusal: 'CONFLICT' };
  }

  private async isPrincipal(principal: BrainWorkPrincipal, jobId: string): Promise<boolean> {
    const row = await this.prisma.brainJob.findFirst({
      where: { id: jobId, organizationId: principal.organizationId, principalUserId: principal.userId },
      select: { id: true },
    });
    return row !== null;
  }

  private async isAdministrator(principal: BrainWorkPrincipal): Promise<boolean> {
    try {
      const authority = await membershipAuthority(this.prisma, principal.organizationId, principal.userId);
      return authority.granted === true && ADMINISTRATOR_ROLES.includes(authority.systemRole);
    } catch {
      return false;
    }
  }

  private async view(organizationId: string, jobId: string): Promise<BrainWorkView | null> {
    const record = await this.jobs.get(organizationId, jobId);
    if (!record) return null;
    const steps = await this.steps.listForJob(organizationId, jobId);
    return brainWorkViewOf(record, steps);
  }
}

function refused(refusal: BrainSubmitRefusal): BrainSubmitOutcome {
  return { kind: 'REFUSED', refusal };
}

function readQuestion(schemaId: string, schemaVersion: string, body: unknown): BrainQuestion | null {
  if (schemaId !== BRAIN_QUESTION_SCHEMA_ID || schemaVersion !== BRAIN_QUESTION_SCHEMA_VERSION) return null;
  const parsed = parseBrainQuestion(body);
  return parsed.ok ? parsed.question : null;
}

/** A job as its principal sees it. No input, no provider, no model, no content. */
export function brainWorkViewOf(
  record: BrainJobRecord,
  steps: readonly { readonly stepKey: string; readonly kind: string; readonly state: string }[],
): BrainWorkView {
  const job: BrainJobSnapshot = record.job;
  const running = steps.find((s) => s.state === 'RUNNING') ?? null;
  return {
    jobId: job.jobId,
    taskId: job.taskId,
    resultType: job.resultType,
    subject: { type: job.subject.type, id: job.subject.id, href: brainSubjectHref(job.subject) },
    executionClass: job.executionClass,
    promoted: job.promoted,
    state: job.state,
    phase: brainWorkPhase(job.state),
    finished: brainJobIsTerminal(job.state),
    waiting: job.wait ? { waitId: job.wait.waitId, expiresAt: new Date(job.wait.expiresAtMs).toISOString() } : null,
    cancelRequested: job.cancelRequest !== null,
    endReason: job.endReason,
    results: job.resultRefs.map((ref) => ({
      authority: ref.owner.authority,
      subjectType: ref.owner.subjectType,
      subjectId: ref.subjectId,
      artifactId: ref.artifactId,
      href: brainSubjectHref({ type: ref.owner.subjectType, id: ref.subjectId }),
    })),
    progress: {
      currentStep: running ? { key: running.stepKey, kind: running.kind } : null,
      completedSteps: steps.filter((s) => s.state === 'SUCCEEDED' || s.state === 'SKIPPED').length,
    },
    acceptedAt: record.acceptedAt.toISOString(),
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
    endedAt: record.endedAt ? record.endedAt.toISOString() : null,
  };
}
