// WorkflowsRepository — Sprint 9 (Workflows & Automation, Internal CRM Phase 4).
//
// The automation spine. Workflows are declarative: a trigger (EVENT / MANUAL /
// SCHEDULE) plus an ordered list of internal steps stored as JSON in the
// existing Workflow.triggerConfig / Workflow.definition columns. A run executes
// those steps through the EXISTING repository layer (tags, pipeline status,
// assignment, notes, conversation status, domain events) and records an
// immutable WorkflowRun. Nothing here touches an external provider: every step
// is an internal data mutation on Neon, consistent with the no-provider rule.
//
// Built entirely on the Workflow / WorkflowRun models and WorkflowTrigger /
// WorkflowRunStatus enums already present in the Sprint 1 schema — nothing is
// reinvented; this repository wires the declarative definition into execution.

import type {
  Prisma,
  PrismaClient,
  Workflow,
  WorkflowRun,
  WorkflowTrigger,
  WorkflowRunStatus,
  ConversationStatus,
} from '@prisma/client';

// Triggers we support in this phase. WEBHOOK / SIGNAL exist in the enum but are
// reserved for a later sprint (they imply provider or model wiring).
export const WORKFLOW_TRIGGERS: WorkflowTrigger[] = ['EVENT', 'MANUAL', 'SCHEDULE'];

// The internal, no-provider step vocabulary. Each maps to an existing
// repository mutation. Adding a provider step would violate the sprint rules,
// so the executor rejects anything outside this set.
export const WORKFLOW_STEP_TYPES = [
  'add_tag',
  'set_pipeline_status',
  'assign',
  'create_note',
  'set_conversation_status',
  'emit_event',
] as const;

export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

/**
 * The record each step acts on, or null when it acts on none.
 *
 * A STEP WHOSE RECORD IS ABSENT DOES NOT APPLY. It is not run, writes nothing,
 * and is recorded as not applicable rather than failed. Ingested events carry no
 * customer (ingestion never decides who someone is), so an event workflow built
 * from customer steps applies to none of them -- which is exactly right, and must
 * not read as a stream of failures.
 */
const STEP_SUBJECT: Record<WorkflowStepType, 'customer' | 'conversation' | null> = {
  add_tag: 'customer',
  set_pipeline_status: 'customer',
  assign: 'customer',
  create_note: 'customer',
  set_conversation_status: 'conversation',
  emit_event: null,
};

/** Whether a step has the record it acts on in this run's context. */
export function stepApplies(step: Pick<WorkflowStep, 'type'>, context: RunContext): boolean {
  const subject = STEP_SUBJECT[step.type];
  if (subject === 'customer') return Boolean(context.customerId);
  if (subject === 'conversation') return Boolean(context.conversationId);
  return true;
}

export interface WorkflowStep {
  type: WorkflowStepType;
  // Free-form, step-specific config. Validated per-type by the executor.
  config: Record<string, unknown>;
}

export interface WorkflowDefinition {
  steps: WorkflowStep[];
}

export interface TriggerConfig {
  // For EVENT triggers: the dotted domain-event name that fires this workflow.
  eventName?: string | null;
  // For SCHEDULE triggers: a human cron-ish hint (not executed in this phase).
  schedule?: string | null;
}

// Normalized trigger config: the reader always fills both keys (null when
// absent) so callers never deal with `undefined`.
interface NormalizedTriggerConfig {
  eventName: string | null;
  schedule: string | null;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  eventName: string | null;
  isActive: boolean;
  stepCount: number;
  lastRunStatus: WorkflowRunStatus | null;
  lastRunAt: string | null;
  runCount: number;
  updatedAt: string;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  triggerConfig: NormalizedTriggerConfig;
  definition: WorkflowDefinition;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  triggeredBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  stepResults: StepResult[];
  error: string | null;
  summary: string;
}

export interface StepResult {
  index: number;
  type: string;
  /** Whether the step ran. False when the record it acts on was absent. */
  applicable: boolean;
  /** Whether the step ran and succeeded. Always false for a step that did not apply. */
  ok: boolean;
  detail: string;
}

export interface RunContext {
  customerId?: string | null;
  conversationId?: string | null;
}

export interface RunOutcome {
  run: WorkflowRun;
  status: WorkflowRunStatus;
  stepResults: StepResult[];
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function readTriggerConfig(v: unknown): NormalizedTriggerConfig {
  const o = asObject(v);
  const eventName = typeof o.eventName === 'string' ? o.eventName : null;
  const schedule = typeof o.schedule === 'string' ? o.schedule : null;
  return { eventName, schedule };
}

function readDefinition(v: unknown): WorkflowDefinition {
  const o = asObject(v);
  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  const steps: WorkflowStep[] = [];
  for (const rs of rawSteps) {
    const so = asObject(rs);
    const type = so.type;
    if (typeof type !== 'string') continue;
    if (!(WORKFLOW_STEP_TYPES as readonly string[]).includes(type)) continue;
    steps.push({
      type: type as WorkflowStepType,
      config: asObject(so.config),
    });
  }
  return { steps };
}

function str(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === 'string' ? v.trim() : '';
}

export class WorkflowsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Reads ----------------------------------------------------------

  /** List workflows for an org with last-run status and counts for the
      list view. Bounded read. */
  async listWorkflows(organizationId: string): Promise<WorkflowListItem[]> {
    const rows = await this.prisma.workflow.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
      take: 500,
      include: {
        runs: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { runs: true } },
      },
    });
    return rows.map((w) => {
      const def = readDefinition(w.definition);
      const tc = readTriggerConfig(w.triggerConfig);
      const last = w.runs[0];
      return {
        id: w.id,
        name: w.name,
        description: w.description ?? '',
        trigger: w.trigger,
        eventName: tc.eventName,
        isActive: w.isActive,
        stepCount: def.steps.length,
        lastRunStatus: last ? last.status : null,
        lastRunAt: last ? last.createdAt.toISOString() : null,
        runCount: w._count.runs,
        updatedAt: w.updatedAt.toISOString(),
      };
    });
  }

  async getWorkflow(organizationId: string, id: string): Promise<WorkflowDetail | null> {
    const w = await this.prisma.workflow.findFirst({ where: { id, organizationId } });
    if (!w) return null;
    return {
      id: w.id,
      name: w.name,
      description: w.description ?? '',
      trigger: w.trigger,
      triggerConfig: readTriggerConfig(w.triggerConfig),
      definition: readDefinition(w.definition),
      isActive: w.isActive,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  }

  async listRuns(
    organizationId: string,
    workflowId: string,
    take = 50,
  ): Promise<WorkflowRunView[]> {
    const rows = await this.prisma.workflowRun.findMany({
      // SCOPED THROUGH THE WORKFLOW, so a run history cannot be read by naming
      // another tenant's workflow id.
      where: { workflowId, workflow: { organizationId } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, take)),
    });
    return rows.map((r) => this.toRunView(r));
  }

  private toRunView(r: WorkflowRun): WorkflowRunView {
    const output = asObject(r.output);
    const rawResults = Array.isArray(output.stepResults) ? output.stepResults : [];
    const stepResults: StepResult[] = [];
    for (const rr of rawResults) {
      const o = asObject(rr);
      stepResults.push({
        index: typeof o.index === 'number' ? o.index : stepResults.length,
        type: typeof o.type === 'string' ? o.type : 'unknown',
        // Runs recorded before steps could be not applicable ran every step.
        applicable: o.applicable !== false,
        ok: o.ok === true,
        detail: typeof o.detail === 'string' ? o.detail : '',
      });
    }
    const applied = stepResults.filter((s) => s.applicable);
    const notApplicable = stepResults.length - applied.length;
    const okCount = applied.filter((s) => s.ok).length;
    const summary =
      stepResults.length === 0
        ? 'No steps executed'
        : applied.length === 0
          ? 'No step applied (' + notApplicable + ' not applicable)'
          : okCount + ' of ' + applied.length + ' steps succeeded' +
            (notApplicable > 0 ? ' · ' + notApplicable + ' not applicable' : '');
    return {
      id: r.id,
      workflowId: r.workflowId,
      status: r.status,
      triggeredBy: r.triggeredBy ?? null,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      stepResults,
      error: r.error ?? null,
      summary,
    };
  }

  // --- Writes (definition) -------------------------------------------

  async createWorkflow(args: {
    organizationId: string;
    name: string;
    description?: string | null;
    trigger: WorkflowTrigger;
    triggerConfig: TriggerConfig;
    definition: WorkflowDefinition;
  }): Promise<Workflow> {
    return this.prisma.workflow.create({
      data: {
        organizationId: args.organizationId,
        name: args.name,
        description: args.description ?? null,
        trigger: args.trigger,
        triggerConfig: (args.triggerConfig ?? {}) as object,
        definition: (args.definition ?? { steps: [] }) as object,
        isActive: false,
      },
    });
  }

  async updateWorkflow(
    id: string,
    args: {
      name?: string;
      description?: string | null;
      trigger?: WorkflowTrigger;
      triggerConfig?: TriggerConfig;
      definition?: WorkflowDefinition;
    },
  ): Promise<Workflow> {
    const data: Prisma.WorkflowUpdateInput = {};
    if (args.name !== undefined) data.name = args.name;
    if (args.description !== undefined) data.description = args.description;
    if (args.trigger !== undefined) data.trigger = args.trigger;
    if (args.triggerConfig !== undefined) {
      data.triggerConfig = args.triggerConfig as object;
    }
    if (args.definition !== undefined) {
      data.definition = args.definition as object;
    }
    return this.prisma.workflow.update({ where: { id }, data });
  }

  /**
   * Turn a workflow on or off.
   *
   * FAILS CLOSED TO NULL across a tenant boundary. This switch starts automatic,
   * unsupervised CRM mutation on every matching event, so it is the last place
   * that should have trusted a caller to have checked whose workflow it is.
   * (That the switch is a bare boolean at all is recorded as Phase Zero debt --
   * bounding it by consequence is machine-authority work, not this PR.)
   */
  async setActive(
    organizationId: string,
    id: string,
    isActive: boolean,
  ): Promise<Workflow | null> {
    const found = await this.prisma.workflow.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!found) return null;
    return this.prisma.workflow.update({ where: { id: found.id }, data: { isActive } });
  }

  // --- Execution engine ----------------------------------------------

  /**
   * Execute a workflow's steps in order against the given context, recording
   * a WorkflowRun. Each step is an internal data mutation routed through the
   * existing tables. A step whose record is absent from the context (a customer
   * step with no customer) does not apply: it is recorded as not applicable,
   * never run, and never counted as a failure.
   *
   * The run is SUCCEEDED when every step that applied succeeded, FAILED when one
   * of them failed, and CANCELED when the workflow has steps but none applied,
   * so nothing ran. The whole thing is wrapped so an unexpected throw is
   * captured on the run row rather than bubbling to the caller.
   */
  async runWorkflow(args: {
    organizationId: string;
    workflowId: string;
    triggeredBy: string;
    context: RunContext;
  }): Promise<RunOutcome> {
    const { organizationId, workflowId, triggeredBy, context } = args;
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, organizationId },
    });
    if (!workflow) {
      throw new Error('Workflow not found in this organization.');
    }
    const def = readDefinition(workflow.definition);

    const run = await this.prisma.workflowRun.create({
      data: {
        organizationId,
        workflowId,
        status: 'RUNNING',
        triggeredBy,
        input: { context } as object,
        startedAt: new Date(),
      },
    });

    const stepResults: StepResult[] = [];
    let runError: string | null = null;
    try {
      for (let i = 0; i < def.steps.length; i++) {
        const step = def.steps[i];
        if (!step) continue;
        if (!stepApplies(step, context)) {
          stepResults.push({
            index: i,
            type: step.type,
            applicable: false,
            ok: false,
            detail: 'Not applicable: no ' + STEP_SUBJECT[step.type] + ' in this run.',
          });
          continue;
        }
        const result = await this.executeStep(organizationId, step, context);
        stepResults.push({ index: i, type: step.type, applicable: true, ok: result.ok, detail: result.detail });
      }
    } catch (err) {
      runError = err instanceof Error ? err.message : 'Unknown execution error';
    }

    const applied = stepResults.filter((s) => s.applicable);
    const nothingApplied = runError === null && def.steps.length > 0 && applied.length === 0;
    const status: WorkflowRunStatus = nothingApplied
      ? 'CANCELED'
      : runError === null && applied.every((s) => s.ok)
        ? 'SUCCEEDED'
        : 'FAILED';

    const finished = await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        output: { stepResults } as object,
        error: nothingApplied ? 'Nothing ran: no step applies to this run.' : runError,
      },
    });

    return { run: finished, status, stepResults };
  }

  /**
   * Event-trigger binding: given a domain event that just fired, run every
   * ACTIVE workflow whose trigger is EVENT, whose configured eventName matches,
   * and at least one of whose steps applies to the event's context. Returns the
   * run outcomes. Failures are isolated per workflow so one broken workflow
   * cannot stop the others.
   *
   * A workflow none of whose steps applies starts no run. Nobody asked for it to
   * run against this event -- the trigger matched, the records it acts on are not
   * there -- so a run row would only be noise in its history. The DomainEvent
   * that fired is still recorded. (A manual run always records, see runWorkflow.)
   */
  async runWorkflowsForEvent(args: {
    organizationId: string;
    eventName: string;
    context: RunContext;
    triggeredBy?: string;
  }): Promise<{ workflowId: string; status: WorkflowRunStatus }[]> {
    const { organizationId, eventName, context } = args;
    const candidates = await this.prisma.workflow.findMany({
      where: { organizationId, isActive: true, trigger: 'EVENT' },
    });
    const matching = candidates.filter(
      (w) =>
        readTriggerConfig(w.triggerConfig).eventName === eventName &&
        readDefinition(w.definition).steps.some((s) => stepApplies(s, context)),
    );
    const outcomes: { workflowId: string; status: WorkflowRunStatus }[] = [];
    for (const w of matching) {
      try {
        const outcome = await this.runWorkflow({
          organizationId,
          workflowId: w.id,
          triggeredBy: args.triggeredBy ?? ('event:' + eventName),
          context,
        });
        outcomes.push({ workflowId: w.id, status: outcome.status });
      } catch {
        outcomes.push({ workflowId: w.id, status: 'FAILED' });
      }
    }
    return outcomes;
  }

  // --- Individual step executors (all internal, no providers) ---------

  private async executeStep(
    organizationId: string,
    step: WorkflowStep,
    context: RunContext,
  ): Promise<{ ok: boolean; detail: string }> {
    const customerId = context.customerId ?? null;
    const conversationId = context.conversationId ?? null;
    try {
      switch (step.type) {
        case 'add_tag': {
          const tag = str(step.config, 'tag');
          if (!tag) return { ok: false, detail: 'No tag configured.' };
          if (!customerId) return { ok: false, detail: 'No customer in context.' };
          await this.addCustomerTag(organizationId, customerId, tag);
          return { ok: true, detail: 'Added tag "' + tag + '".' };
        }
        case 'set_pipeline_status': {
          const status = str(step.config, 'status');
          if (!status) return { ok: false, detail: 'No status configured.' };
          if (!customerId) return { ok: false, detail: 'No customer in context.' };
          await this.setPipelineStatus(organizationId, customerId, status);
          return { ok: true, detail: 'Set pipeline status to ' + status + '.' };
        }
        case 'assign': {
          const name = str(step.config, 'humanName');
          if (!customerId) return { ok: false, detail: 'No customer in context.' };
          await this.setAssignment(organizationId, customerId, name || null);
          return { ok: true, detail: name ? 'Assigned to ' + name + '.' : 'Cleared assignment.' };
        }
        case 'create_note': {
          const text = str(step.config, 'text');
          if (!text) return { ok: false, detail: 'No note text configured.' };
          if (!customerId) return { ok: false, detail: 'No customer in context.' };
          await this.createNote(organizationId, customerId, conversationId, text);
          return { ok: true, detail: 'Recorded note.' };
        }
        case 'set_conversation_status': {
          const status = str(step.config, 'status');
          if (!status) return { ok: false, detail: 'No status configured.' };
          if (!conversationId) return { ok: false, detail: 'No conversation in context.' };
          await this.setConversationStatus(organizationId, conversationId, status);
          return { ok: true, detail: 'Set conversation status to ' + status + '.' };
        }
        case 'emit_event': {
          const name = str(step.config, 'eventName');
          if (!name) return { ok: false, detail: 'No event name configured.' };
          await this.prisma.domainEvent.create({
            data: {
              organizationId,
              name,
              aggregateType: customerId ? 'customer' : conversationId ? 'conversation' : null,
              aggregateId: customerId ?? conversationId ?? null,
              payload: { source: 'workflow' } as object,
            },
          });
          return { ok: true, detail: 'Emitted event ' + name + '.' };
        }
        default:
          return { ok: false, detail: 'Unknown step type.' };
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Step error.' };
    }
  }

  private async addCustomerTag(
    organizationId: string,
    customerId: string,
    tag: string,
  ): Promise<void> {
    const c = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId },
      select: { tags: true },
    });
    if (!c) throw new Error('Customer not found.');
    const next = Array.from(new Set([...(c.tags ?? []), tag])).filter(Boolean);
    await this.prisma.customer.update({ where: { id: customerId }, data: { tags: next } });
  }

  private async patchAttributes(
    organizationId: string,
    customerId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const c = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId },
      select: { attributes: true },
    });
    if (!c) throw new Error('Customer not found.');
    const current = asObject(c.attributes);
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { attributes: { ...current, ...patch } as object },
    });
  }

  private setPipelineStatus(
    organizationId: string,
    customerId: string,
    status: string,
  ): Promise<void> {
    return this.patchAttributes(organizationId, customerId, { pipelineStatus: status });
  }

  private setAssignment(
    organizationId: string,
    customerId: string,
    humanName: string | null,
  ): Promise<void> {
    return this.patchAttributes(organizationId, customerId, { assignedHumanName: humanName });
  }

  private async createNote(
    organizationId: string,
    customerId: string,
    conversationId: string | null,
    text: string,
  ): Promise<void> {
    await this.prisma.interaction.create({
      data: {
        organizationId,
        customerId,
        conversationId: conversationId ?? null,
        channel: 'OTHER',
        kind: 'NOTE',
        direction: 'INTERNAL',
        summary: text,
        payload: { source: 'workflow' } as object,
      },
    });
  }

  private async setConversationStatus(
    organizationId: string,
    conversationId: string,
    status: string,
  ): Promise<void> {
    const valid = ['OPEN', 'PENDING', 'SNOOZED', 'CLOSED'];
    if (!valid.includes(status)) throw new Error('Invalid conversation status.');
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { id: true },
    });
    if (!conv) throw new Error('Conversation not found.');
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: status as ConversationStatus },
    });
  }
}
