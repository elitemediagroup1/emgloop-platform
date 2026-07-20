// Sprint 27D — Business Process Engine · PR B (Runtime & Engine Repository)
// ---------------------------------------------------------------------------
// The durable runtime that executes the frozen PR A contracts against the append-
// only transition log. It persists definitions, instances, and transitions, and
// projects current state on demand — it stores NO derived state.
//
// Two frozen constitutional decisions are enforced HERE:
//  1. The transition log is the sole source of truth. `projectCurrentState`
//     rebuilds everything from the log; there is no current-state column to read.
//  2. Readiness is re-derived FRESH before every committed (forward) transition
//     via an injected ReadinessPort — never from the stored snapshot. If readiness
//     has changed since the proposal, the transition is rejected.
//
// Boundaries held (per the PR B ticket):
//  - This PR does NOT integrate Operational Readiness, Work Intelligence, or the
//    Executive Brain. Readiness arrives through a PORT (injected; a stub in tests;
//    wired to the real engine in PR C). Work is NEVER created — a successful
//    transition may only DESCRIBE an ExecutionIntent.
//  - Multi-tenant rules: organizationId is the first argument to every method;
//    single rows resolve with findFirst({ where: { id, organizationId } }) and fail
//    closed; a cross-org id is not-found, never forbidden.
// ---------------------------------------------------------------------------

import type { Prisma, PrismaClient, ProcessDefinition, ProcessInstance } from '@prisma/client';

import {
  evaluateTransition,
  isConfirmationRequired,
  nextAdvanceablePhaseKey,
  type GuardResult,
} from './business-process.policy';
import {
  projectState,
  type RuntimeState,
  type TransitionLogEntry,
} from './business-process.projection';
import {
  TRANSITION_KINDS,
  type BusinessObjectiveReference,
  type BusinessProcessDefinition,
  type BusinessProcessInstance,
  type GuardFacts,
  type PhaseDefinition,
  type PhaseInstance,
  type PhaseState,
  type ProcessSubject,
  type Readiness,
  type TransitionKind,
  type TransitionProposer,
} from './business-process.contracts';

type Tx = Prisma.TransactionClient | PrismaClient;

class NotFoundError extends Error {}
function notFound(what: string, id: string): never {
  throw new NotFoundError(`${what} not found: ${id}`);
}

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------
export interface CreateDefinitionInput {
  organizationId: string;
  key: string;
  name: string;
  objective: BusinessObjectiveReference;
  subjectType: string;
  phases: PhaseDefinition[];
  allowBackward?: boolean;
  allowRestart?: boolean;
  metadata?: Record<string, unknown>;
  createdByUserId?: string | null;
}

export interface CreateInstanceInput {
  organizationId: string;
  definitionId: string; // must reference a PUBLISHED definition version
  subject: ProcessSubject;
  objectiveOverrideLabel?: string | null;
  metadata?: Record<string, unknown>;
  createdByUserId?: string | null;
}

// A transition proposed to the runtime. The runtime accepts a ProposedTransition
// only (no Brain, no reasoning). `verification` is the Verification verdict for the
// current phase's exit; `proposedReadiness` is what readiness looked like at
// proposal time — supplied only for the staleness check, it NEVER authorizes.
export interface ProposedTransition {
  kind: TransitionKind;
  proposer: TransitionProposer;
  toPhaseKey?: string | null;
  confirmed?: boolean;
  confirmedByUserId?: string | null;
  proposedByUserId?: string | null;
  rationale?: string | null;
  verification?: { verified: boolean; snapshot?: Record<string, unknown> } | null;
  proposedReadiness?: Readiness;
}

// The entry-gate readiness re-derivation port. Injected — PR B never depends on the
// real Operational Readiness engine. Called FRESH at commit time for forward.
export interface ReadinessQuery {
  organizationId: string;
  instanceId: string;
  subject: ProcessSubject;
  objective: BusinessObjectiveReference;
  definition: BusinessProcessDefinition;
  targetPhase: PhaseDefinition;
  projection: RuntimeState;
}
export type ReadinessPort = (query: ReadinessQuery) => Readiness | Promise<Readiness>;

// A successful transition may DESCRIBE the work that should happen next. Nothing is
// created — this is the boundary to Work Intelligence, represented only.
export interface ExecutionIntent {
  processInstanceId: string;
  enteredPhaseKey: string;
  ownerResponsibilityKey: string;
  expectedOutcomes: string[];
}

export interface ApplyTransitionResult {
  applied: boolean;
  guard: GuardResult;
  state: RuntimeState;
  sequence?: number;
  executionIntent?: ExecutionIntent | null;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------
function toDefinitionContract(row: ProcessDefinition): BusinessProcessDefinition {
  return {
    key: row.key,
    name: row.name,
    version: row.version,
    objective: { key: row.objectiveKey, label: row.objectiveLabel },
    subjectType: row.subjectType,
    phases: (row.phases as unknown as PhaseDefinition[]) ?? [],
    allowBackward: row.allowBackward,
    allowRestart: row.allowRestart,
  };
}

function phaseDefByKey(def: BusinessProcessDefinition, key: string | null | undefined): PhaseDefinition | null {
  if (key == null) return null;
  return def.phases.find((p) => p.key === key) ?? null;
}

export class BusinessProcessRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ================================================================
  // Definitions — immutable, versioned, publishable
  // ================================================================
  async createDefinition(input: CreateDefinitionInput): Promise<ProcessDefinition> {
    validatePhases(input.phases);
    // Next version for (org, key): max existing + 1.
    const latest = await this.prisma.processDefinition.findFirst({
      where: { organizationId: input.organizationId, key: input.key },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    return this.prisma.processDefinition.create({
      data: {
        organizationId: input.organizationId,
        key: input.key,
        version,
        name: input.name,
        status: 'draft',
        objectiveKey: input.objective.key,
        objectiveLabel: input.objective.label ?? null,
        subjectType: input.subjectType,
        allowBackward: input.allowBackward ?? false,
        allowRestart: input.allowRestart ?? false,
        phases: input.phases as unknown as Prisma.InputJsonValue,
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        createdByUserId: input.createdByUserId ?? null,
      },
    });
  }

  // Freeze a draft. Once published a definition is immutable — there is no update
  // method; a change is a new version (createDefinition again).
  async publishDefinition(organizationId: string, definitionId: string): Promise<ProcessDefinition> {
    const existing = await this.prisma.processDefinition.findFirst({
      where: { id: definitionId, organizationId },
    });
    if (!existing) notFound('Process definition', definitionId);
    if (existing.status === 'published') {
      throw new Error('Process definition is already published and immutable');
    }
    return this.prisma.processDefinition.update({
      where: { id: existing.id },
      data: { status: 'published', publishedAt: new Date() },
    });
  }

  async getDefinitionById(
    organizationId: string,
    definitionId: string,
  ): Promise<ProcessDefinition | null> {
    return this.prisma.processDefinition.findFirst({ where: { id: definitionId, organizationId } });
  }

  async getDefinition(
    organizationId: string,
    key: string,
    version: number,
  ): Promise<ProcessDefinition | null> {
    return this.prisma.processDefinition.findFirst({
      where: { organizationId, key, version },
    });
  }

  // ================================================================
  // Instances — pin the version; store references only, never state
  // ================================================================
  async createInstance(input: CreateInstanceInput): Promise<ProcessInstance> {
    const def = await this.prisma.processDefinition.findFirst({
      where: { id: input.definitionId, organizationId: input.organizationId },
    });
    if (!def) notFound('Process definition', input.definitionId);
    if (def.status !== 'published') {
      throw new Error('Cannot instantiate a process from an unpublished definition');
    }
    return this.prisma.processInstance.create({
      data: {
        organizationId: input.organizationId,
        definitionId: def.id,
        definitionKey: def.key,
        definitionVersion: def.version, // PINNED — never re-read to a newer version
        subjectType: input.subject.type,
        subjectLabel: input.subject.label,
        subjectExternalId: input.subject.externalId ?? null,
        objectiveKey: def.objectiveKey,
        objectiveLabel: input.objectiveOverrideLabel ?? def.objectiveLabel ?? null,
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        createdByUserId: input.createdByUserId ?? null,
      },
    });
  }

  async loadInstance(organizationId: string, instanceId: string): Promise<ProcessInstance | null> {
    return this.prisma.processInstance.findFirst({ where: { id: instanceId, organizationId } });
  }

  // Administrative retention only. Legal solely from a terminal projected state;
  // there is no `archive` transition kind, so this does not touch the log.
  async archiveInstance(organizationId: string, instanceId: string): Promise<ProcessInstance> {
    const state = await this.projectCurrentState(organizationId, instanceId);
    if (!state.isTerminal) {
      throw new Error('Only a terminal process may be archived');
    }
    return this.prisma.processInstance.update({
      where: { id: instanceId },
      data: { archivedAt: new Date() },
    });
  }

  // ================================================================
  // Transition log (append-only) & projection
  // ================================================================
  async getHistory(organizationId: string, instanceId: string): Promise<TransitionLogEntry[]> {
    const rows = await this.prisma.processTransition.findMany({
      where: { organizationId, processInstanceId: instanceId },
      orderBy: { sequence: 'asc' },
    });
    return rows.map((r) => ({
      sequence: r.sequence,
      kind: r.kind as TransitionKind,
      fromPhaseKey: r.fromPhaseKey,
      toPhaseKey: r.toPhaseKey,
    }));
  }

  async projectCurrentState(organizationId: string, instanceId: string): Promise<RuntimeState> {
    const instance = await this.prisma.processInstance.findFirst({
      where: { id: instanceId, organizationId },
    });
    if (!instance) notFound('Process instance', instanceId);
    const def = await this.prisma.processDefinition.findFirst({
      where: { id: instance.definitionId, organizationId },
    });
    if (!def) notFound('Process definition', instance.definitionId);
    const history = await this.getHistory(organizationId, instanceId);
    return projectState(toDefinitionContract(def), history, { archivedAt: instance.archivedAt });
  }

  // Raw append primitive (append-only). Used by applyTransition; also usable
  // directly for import/replay. It performs NO guard evaluation — callers that
  // need guarding go through applyTransition.
  private async appendTransition(
    tx: Tx,
    input: {
      organizationId: string;
      processInstanceId: string;
      sequence: number;
      kind: TransitionKind;
      fromPhaseKey: string | null;
      toPhaseKey: string | null;
      proposer: TransitionProposer;
      proposedByUserId: string | null;
      confirmedByUserId: string | null;
      readinessSnapshot: Prisma.InputJsonValue;
      verificationSnapshot: Prisma.InputJsonValue;
      rationale: string | null;
    },
  ): Promise<void> {
    await tx.processTransition.create({
      data: {
        organizationId: input.organizationId,
        processInstanceId: input.processInstanceId,
        sequence: input.sequence,
        kind: input.kind,
        fromPhaseKey: input.fromPhaseKey,
        toPhaseKey: input.toPhaseKey,
        proposer: input.proposer,
        proposedByUserId: input.proposedByUserId,
        confirmedByUserId: input.confirmedByUserId,
        readinessSnapshot: input.readinessSnapshot,
        verificationSnapshot: input.verificationSnapshot,
        rationale: input.rationale,
      },
    });
  }

  // ================================================================
  // applyTransition — the guarded runtime entry point
  // ================================================================
  // Steps (no shortcuts, no hidden mutation):
  //   1. Load current projection (from the log).
  //   2. Re-derive readiness FRESH (forward only — the sole entry-gated kind).
  //   3. Validate the guard policy (PR A).
  //   4. Validate confirmation.
  //   5. Append the transition (append-only) — only if allowed.
  //   6. Rebuild the projection from the log.
  //   7. Return the updated runtime state (+ any ExecutionIntent).
  // A rejected transition returns { applied: false } with the guard denials and
  // the UNCHANGED projection — nothing is appended.
  async applyTransition(
    organizationId: string,
    instanceId: string,
    proposed: ProposedTransition,
    readinessPort: ReadinessPort,
  ): Promise<ApplyTransitionResult> {
    if (!(TRANSITION_KINDS as readonly string[]).includes(proposed.kind)) {
      throw new Error(`Unknown transition kind: ${proposed.kind}`);
    }
    // (1) Load instance, definition, and project current state from the log.
    const instance = await this.prisma.processInstance.findFirst({
      where: { id: instanceId, organizationId },
    });
    if (!instance) notFound('Process instance', instanceId);
    const defRow = await this.prisma.processDefinition.findFirst({
      where: { id: instance.definitionId, organizationId },
    });
    if (!defRow) notFound('Process definition', instance.definitionId);
    const definition = toDefinitionContract(defRow);
    const history = await this.getHistory(organizationId, instanceId);
    const projection = projectState(definition, history, { archivedAt: instance.archivedAt });

    // Resolve the target phase. For forward without an explicit target, use the
    // next advanceable phase; the guard still requires the exact key to match.
    const guardInstanceBase = buildGuardInstance(definition, projection);
    let toPhaseKey = proposed.toPhaseKey ?? null;
    if (proposed.kind === 'forward' && toPhaseKey == null) {
      toPhaseKey = nextAdvanceablePhaseKey(definition, guardInstanceBase);
    }

    // (2) Re-derive readiness FRESH for the entry-gated kind (forward). Never trust
    // a snapshot. Other kinds have no entry gate → readiness is not consulted.
    const denials: string[] = [];
    let freshReadiness: Readiness | undefined;
    if (proposed.kind === 'forward') {
      const targetPhase = phaseDefByKey(definition, toPhaseKey);
      if (targetPhase) {
        freshReadiness = await readinessPort({
          organizationId,
          instanceId,
          subject: subjectOf(instance),
          objective: objectiveOf(instance),
          definition,
          targetPhase,
          projection,
        });
        // Stale-readiness rejection: if the proposal observed a readiness value and
        // the fresh re-derivation differs, reject — the world changed under it.
        if (proposed.proposedReadiness !== undefined && proposed.proposedReadiness !== freshReadiness) {
          denials.push(
            `readiness changed since proposal (was '${String(proposed.proposedReadiness)}', now '${String(freshReadiness)}') — re-propose`,
          );
        }
      }
    }

    // (3+4) Validate the guard policy + confirmation on FRESH facts.
    const exitVerified = proposed.verification?.verified === true;
    const facts: GuardFacts = {
      exitVerified,
      entryReady: freshReadiness,
    };
    const guardInstance = overlayVerification(guardInstanceBase, projection.currentPhaseKey, proposed.kind, exitVerified);
    const guard = evaluateTransition({
      definition,
      instance: guardInstance,
      transition: {
        kind: proposed.kind,
        proposer: proposed.proposer,
        toPhaseKey,
        confirmed: proposed.confirmed,
      },
      facts,
    });

    const allowed = guard.decision === 'allow' && denials.length === 0;
    if (!allowed) {
      return {
        applied: false,
        guard: { ...guard, denials: [...guard.denials, ...denials] },
        state: projection,
        executionIntent: null,
      };
    }

    // (5) Append the transition (append-only). Sequence is the next contiguous int;
    // the unique (instance, sequence) index makes a racing double-append fail.
    const sequence = projection.lastSequence + 1;
    const confirmedByUserId = isConfirmationRequired(proposed.kind)
      ? proposed.confirmedByUserId ?? null
      : null;
    await this.appendTransition(this.prisma, {
      organizationId,
      processInstanceId: instanceId,
      sequence,
      kind: proposed.kind,
      fromPhaseKey: projection.currentPhaseKey,
      toPhaseKey,
      proposer: proposed.proposer,
      proposedByUserId: proposed.proposedByUserId ?? null,
      confirmedByUserId,
      readinessSnapshot: (freshReadiness !== undefined
        ? { entryReady: freshReadiness }
        : {}) as Prisma.InputJsonValue,
      verificationSnapshot: (proposed.verification ?? {}) as Prisma.InputJsonValue,
      rationale: proposed.rationale ?? null,
    });

    // (6) Rebuild the projection from the log.
    const newHistory = await this.getHistory(organizationId, instanceId);
    const newState = projectState(definition, newHistory, { archivedAt: instance.archivedAt });

    // (7) Return the updated state (+ execution intent when a phase was entered).
    return {
      applied: true,
      guard,
      state: newState,
      sequence,
      executionIntent: buildExecutionIntent(definition, instanceId, proposed.kind, toPhaseKey),
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------
function subjectOf(instance: ProcessInstance): ProcessSubject {
  return {
    type: instance.subjectType,
    label: instance.subjectLabel,
    externalId: instance.subjectExternalId,
  };
}
function objectiveOf(instance: ProcessInstance): BusinessObjectiveReference {
  return { key: instance.objectiveKey, label: instance.objectiveLabel };
}

// Build the BusinessProcessInstance the guard reasons over, from the projection.
// Phase states are the projected POSITION states.
function buildGuardInstance(
  definition: BusinessProcessDefinition,
  projection: RuntimeState,
): BusinessProcessInstance {
  const phases: PhaseInstance[] = projection.phases.map((p) => ({
    phaseKey: p.phaseKey,
    state: p.state,
    reopenedCount: p.reopenedCount,
  }));
  return {
    definitionKey: definition.key,
    definitionVersion: definition.version,
    subject: { type: definition.subjectType, label: '' },
    objective: definition.objective,
    // The guard reasons over the effective (archival-aware) process state.
    state: projection.effectiveState,
    currentPhaseKey: projection.currentPhaseKey,
    phases,
  };
}

// The projection cannot know a phase is `satisfied`/`verified` (those are transient
// Work-Intelligence/Verification facts, not logged). For forward/complete, overlay
// the current phase's state to `verified` when the Verification verdict says so, so
// the frozen PR A structural guard evaluates correctly. When not verified, the
// projected `active` remains and the guard denies (as it should).
function overlayVerification(
  base: BusinessProcessInstance,
  currentPhaseKey: string | null,
  kind: TransitionKind,
  exitVerified: boolean,
): BusinessProcessInstance {
  if ((kind !== 'forward' && kind !== 'complete') || !exitVerified || currentPhaseKey == null) {
    return base;
  }
  const phases = base.phases.map((p): PhaseInstance =>
    p.phaseKey === currentPhaseKey ? { ...p, state: 'verified' as PhaseState } : p,
  );
  return { ...base, phases };
}

function buildExecutionIntent(
  definition: BusinessProcessDefinition,
  instanceId: string,
  kind: TransitionKind,
  toPhaseKey: string | null,
): ExecutionIntent | null {
  // A phase is ENTERED by forward, backward (regress into), or reopen.
  if (kind !== 'forward' && kind !== 'backward' && kind !== 'reopen') return null;
  if (toPhaseKey == null) return null;
  const phase = definition.phases.find((p) => p.key === toPhaseKey);
  if (!phase) return null;
  return {
    processInstanceId: instanceId,
    enteredPhaseKey: phase.key,
    ownerResponsibilityKey: phase.ownerResponsibilityKey,
    expectedOutcomes: phase.expectedOutcomes ?? [],
  };
}

// Light structural validation of a definition's phases (positions & keys unique,
// at least one phase). Deeper validation is the authoring concern of PR D.
function validatePhases(phases: PhaseDefinition[]): void {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error('A process definition requires at least one phase');
  }
  const keys = new Set<string>();
  const positions = new Set<number>();
  for (const p of phases) {
    if (!p.key) throw new Error('Every phase requires a key');
    if (keys.has(p.key)) throw new Error(`Duplicate phase key: ${p.key}`);
    if (positions.has(p.position)) throw new Error(`Duplicate phase position: ${p.position}`);
    if (!p.ownerResponsibilityKey) throw new Error(`Phase ${p.key} requires an owner responsibility key`);
    keys.add(p.key);
    positions.add(p.position);
  }
}
