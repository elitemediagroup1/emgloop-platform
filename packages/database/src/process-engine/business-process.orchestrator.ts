// Sprint 27E — Business Process Engine · PR C (Process Orchestrator)
// ---------------------------------------------------------------------------
// The BusinessProcessOrchestrator is the ONLY coordinator between the pure
// Business Process Runtime (BusinessProcessRepository) and the platform boundaries
// it depends on. It exists so the runtime never reaches out to Operational
// Readiness, Verification, Work Intelligence, or the Executive Brain — those
// dependencies arrive as injected PORTS and the orchestrator wires them together.
//
// It coordinates; it never decides. Specifically it NEVER:
//   - derives readiness            → asks OperationalReadinessPort
//   - performs verification        → asks PhaseVerificationPort
//   - creates work                 → emits an ExecutionIntent to ExecutionIntentSink
//                                     (DESCRIBE only — no WorkInstance, no assignment)
//   - reasons                      → a Brain proposal is coordinated through the SAME
//                                     path with no bypass (proposer is recorded, not trusted)
//
// The coordinated steps of a transition (Sprint 27E ticket):
//   1. Request FRESH readiness through OperationalReadinessPort. This happens via the
//      runtime's injected re-derivation, so readiness is re-checked AT COMMIT time and
//      never trusted from a snapshot (constitutional decision #2 of PR B).
//   2. Request exit verification through PhaseVerificationPort (forward / complete only).
//   3. Invoke the pure Business Process Runtime (applyTransition).
//   4. Emit an ExecutionIntent through ExecutionIntentSink (best-effort; no work created).
//   5. Return the updated RuntimeState, or a typed OrchestrationFailure.
//
// Fail-closed by construction. The DEFAULT ports REFUSE: readiness defaults to
// 'unknown' (which never advances a process), verification defaults to
// { verified: false }, and the default sink is an in-memory collector that creates
// nothing. These defaults exist ONLY so the orchestration layer can be fully
// implemented and deterministically tested WITHOUT the real Operational Readiness /
// Verification engines — which do not exist yet (Sprint 27E discovery: both were only
// injectable holes; there is no evaluator to duplicate). Substitute real ports by
// injection when they land — no orchestrator change required. This layer deliberately
// contains NO readiness or verification LOGIC; that logic belongs to those engines.
//
// Dependency-injected end to end: every collaborator is a constructor port, so unit
// tests substitute fakes and the orchestration is independent of infrastructure.
//
// Multi-tenant: organizationId is ALWAYS the caller's session-derived scope and is the
// first argument. A cross-org or absent instance resolves to a typed
// ORGANIZATION_MISMATCH failure — never a leak of another tenant's existence.
// ---------------------------------------------------------------------------

import type {
  BusinessProcessDefinition,
  PhaseDefinition,
  Readiness,
  TransitionKind,
  TransitionProposer,
} from './business-process.contracts';
import type { GuardResult } from './business-process.policy';
import type { RuntimeState } from './business-process.projection';
import {
  BusinessProcessRepository,
  type ExecutionIntent,
  type ProposedTransition,
  type ReadinessPort,
  type ReadinessQuery,
} from './business-process.repository';

// ===========================================================================
// Ports — the injected boundaries the orchestrator coordinates
// ===========================================================================

// Operational Readiness boundary. The orchestrator asks this — it NEVER derives
// readiness itself. Called fresh at commit time (through the runtime) for the entry-
// gated kind (forward). `ReadinessQuery` is the runtime's own query shape, reused so
// there is one canonical readiness contract across the engine.
export interface OperationalReadinessPort {
  evaluateEntryReadiness(query: ReadinessQuery): Readiness | Promise<Readiness>;
}

// Verification boundary. The orchestrator asks whether the CURRENT phase's exit has
// been independently verified. It NEVER performs verification, and it never trusts a
// proposer-supplied verdict — the verdict always comes from this port.
export interface PhaseVerificationQuery {
  organizationId: string;
  instanceId: string;
  definition: BusinessProcessDefinition;
  currentPhase: PhaseDefinition; // the phase whose exit criteria are under verification
  projection: RuntimeState;
}
export interface PhaseVerificationVerdict {
  verified: boolean;
  snapshot?: Record<string, unknown>;
}
export interface PhaseVerificationPort {
  verifyPhaseExit(query: PhaseVerificationQuery): PhaseVerificationVerdict | Promise<PhaseVerificationVerdict>;
}

// Work Intelligence boundary. A successful transition DESCRIBES the work that should
// follow as an ExecutionIntent; the sink receives it. The sink must NOT create work —
// that remains Work Intelligence's responsibility (this PR emits intent only).
export interface ExecutionIntentContext {
  organizationId: string;
  instanceId: string;
}
export interface ExecutionIntentSink {
  emit(intent: ExecutionIntent, context: ExecutionIntentContext): void | Promise<void>;
}

// ===========================================================================
// Fail-closed default adapters (test/no-engine substitutes — NOT real engines)
// ===========================================================================

// Readiness defaults to 'unknown', which the PR A guard treats as "never advance".
// Absent a real Operational Readiness engine, a process is not ready.
export const FAIL_CLOSED_READINESS_PORT: OperationalReadinessPort = {
  evaluateEntryReadiness: () => 'unknown',
};

// Verification defaults to not-verified. Absent a real Verification engine, no phase
// exit is verified, so forward/complete cannot proceed.
export const FAIL_CLOSED_VERIFICATION_PORT: PhaseVerificationPort = {
  verifyPhaseExit: () => ({ verified: false }),
};

// A no-op sink that only RECORDS emitted intents in memory. Creates no work. Useful in
// tests and as a safe default until a real Work Intelligence consumer is wired.
export class CollectingExecutionIntentSink implements ExecutionIntentSink {
  readonly collected: Array<{ intent: ExecutionIntent; context: ExecutionIntentContext }> = [];
  emit(intent: ExecutionIntent, context: ExecutionIntentContext): void {
    this.collected.push({ intent, context });
  }
}

// ===========================================================================
// Public request / result shapes
// ===========================================================================

// A transition request as it enters the orchestrator. Note what is ABSENT: there is no
// verification fact and no readiness value here. The orchestrator OWNS those — it
// obtains verification from the port and readiness from the port at commit time. The
// only proposer-observed readiness accepted is `observedReadiness`, and it can ONLY
// cause a staleness rejection (it never authorizes an advance).
export interface TransitionRequest {
  organizationId: string;
  instanceId: string;
  kind: TransitionKind;
  proposer: TransitionProposer;
  toPhaseKey?: string | null;
  confirmed?: boolean;
  confirmedByUserId?: string | null;
  proposedByUserId?: string | null;
  rationale?: string | null;
  // What readiness the proposer observed at proposal time. Used ONLY for the runtime's
  // fresh-vs-proposal staleness check — a changed world rejects the (later) commit.
  observedReadiness?: Readiness;
  // Optional guard against a proposal authored for a different pinned definition
  // version. When present and unequal to the instance's pinned version → typed failure.
  expectedDefinitionVersion?: number;
}

export const ORCHESTRATION_FAILURE_REASONS = [
  'ORGANIZATION_MISMATCH', // instance absent or belongs to another tenant (no leak)
  'DEFINITION_VERSION_MISMATCH', // proposal targets a different pinned version
  'ILLEGAL_TRANSITION', // structurally illegal from the current state
  'CONFIRMATION_MISSING', // a business-changing kind was not confirmed
  'VERIFICATION_FAILED', // the current phase exit is not verified
  'NOT_READY', // target entry not ready / unknown / readiness changed since proposal
] as const;
export type OrchestrationFailureReason = (typeof ORCHESTRATION_FAILURE_REASONS)[number];

export interface OrchestrationSuccess {
  ok: true;
  applied: true;
  state: RuntimeState;
  sequence: number;
  executionIntent: ExecutionIntent | null;
  intentEmitted: boolean; // whether the sink accepted the intent (best-effort delivery)
  guard: GuardResult;
}
export interface OrchestrationFailure {
  ok: false;
  applied: false;
  reason: OrchestrationFailureReason;
  denials: string[];
  // The UNCHANGED projection when one is available (null only when the instance could
  // not be resolved in this organization).
  state: RuntimeState | null;
  guard?: GuardResult;
}
export type OrchestrationResult = OrchestrationSuccess | OrchestrationFailure;

// ===========================================================================
// Dependency injection
// ===========================================================================

export interface OrchestratorPorts {
  readiness?: OperationalReadinessPort;
  verification?: PhaseVerificationPort;
  intentSink?: ExecutionIntentSink;
}
export interface OrchestratorDependencies extends OrchestratorPorts {
  repository: BusinessProcessRepository;
}

// ===========================================================================
// Orchestrator
// ===========================================================================

export class BusinessProcessOrchestrator {
  private readonly repository: BusinessProcessRepository;
  private readonly readiness: OperationalReadinessPort;
  private readonly verification: PhaseVerificationPort;
  private readonly intentSink: ExecutionIntentSink;

  constructor(deps: OrchestratorDependencies) {
    this.repository = deps.repository;
    // Every port defaults FAIL-CLOSED. An orchestrator built with only a repository
    // refuses every advance until real ports are injected.
    this.readiness = deps.readiness ?? FAIL_CLOSED_READINESS_PORT;
    this.verification = deps.verification ?? FAIL_CLOSED_VERIFICATION_PORT;
    this.intentSink = deps.intentSink ?? new CollectingExecutionIntentSink();
  }

  // -------------------------------------------------------------------------
  // requestTransition — the coordinated entry point (the five steps).
  // -------------------------------------------------------------------------
  async requestTransition(request: TransitionRequest): Promise<OrchestrationResult> {
    const { organizationId, instanceId } = request;

    // (0) Resolve the instance WITHIN the org. Cross-org or absent → typed mismatch,
    // never a leak, never a throw.
    const ctx = await this.repository.loadInstanceContext(organizationId, instanceId);
    if (!ctx) {
      return {
        ok: false,
        applied: false,
        reason: 'ORGANIZATION_MISMATCH',
        denials: ['process instance not found in this organization'],
        state: null,
      };
    }
    const { instance, definition, projection } = ctx;

    // (0b) Definition-version guard — a proposal authored against a different pinned
    // version is rejected before the engine is invoked.
    if (
      request.expectedDefinitionVersion !== undefined &&
      request.expectedDefinitionVersion !== instance.definitionVersion
    ) {
      return {
        ok: false,
        applied: false,
        reason: 'DEFINITION_VERSION_MISMATCH',
        denials: [
          `definition version mismatch (expected ${request.expectedDefinitionVersion}, instance pinned ${instance.definitionVersion})`,
        ],
        state: projection,
      };
    }

    // (2) Request exit verification through the port — ONLY for kinds that gate on the
    // current phase's exit: forward from a live phase, or complete. The orchestrator
    // never trusts a proposer verdict; the verdict is always the port's answer. For
    // initial entry (draft → first phase) there is no exit, so no verification is asked.
    let verification: ProposedTransition['verification'];
    const gatesOnExit =
      (request.kind === 'forward' && projection.currentPhaseKey != null) || request.kind === 'complete';
    const currentPhase = phaseByKey(definition, projection.currentPhaseKey);
    const verificationAsked = gatesOnExit && currentPhase != null;
    if (verificationAsked && currentPhase) {
      const verdict = await this.verification.verifyPhaseExit({
        organizationId,
        instanceId,
        definition,
        currentPhase,
        projection,
      });
      verification = {
        verified: verdict.verified === true,
        ...(verdict.snapshot ? { snapshot: verdict.snapshot } : {}),
      };
    }

    // (1 + 3) Invoke the runtime. Readiness is re-derived FRESH inside applyTransition
    // via the injected adapter — step (1) happens there, at commit time, from the port.
    const proposed: ProposedTransition = {
      kind: request.kind,
      proposer: request.proposer,
      toPhaseKey: request.toPhaseKey ?? null,
      confirmed: request.confirmed,
      confirmedByUserId: request.confirmedByUserId ?? null,
      proposedByUserId: request.proposedByUserId ?? null,
      rationale: request.rationale ?? null,
      verification: verification ?? null,
      ...(request.observedReadiness !== undefined ? { proposedReadiness: request.observedReadiness } : {}),
    };
    const readinessAdapter: ReadinessPort = (query) => this.readiness.evaluateEntryReadiness(query);
    const result = await this.repository.applyTransition(
      organizationId,
      instanceId,
      proposed,
      readinessAdapter,
    );

    if (!result.applied) {
      return {
        ok: false,
        applied: false,
        reason: classifyGuardFailure(result.guard, {
          verificationAsked,
          verificationVerdict: verification?.verified === true,
        }),
        denials: result.guard.denials,
        state: result.state,
        guard: result.guard,
      };
    }

    // (4) Emit the ExecutionIntent (describe only — never creates work). Best-effort:
    // the business transition is ALREADY committed to the append-only log, so a sink
    // failure must not report the committed transition as failed.
    let intentEmitted = false;
    if (result.executionIntent) {
      try {
        await this.intentSink.emit(result.executionIntent, { organizationId, instanceId });
        intentEmitted = true;
      } catch {
        intentEmitted = false; // delivery is best-effort; the commit stands.
      }
    }

    // (5) Return the updated projection. `sequence` is guaranteed set when applied.
    return {
      ok: true,
      applied: true,
      state: result.state,
      sequence: result.sequence ?? projection.lastSequence + 1,
      executionIntent: result.executionIntent ?? null,
      intentEmitted,
      guard: result.guard,
    };
  }

  // -------------------------------------------------------------------------
  // submitProposal — Executive Brain (and human) proposal intake.
  //
  // "Support Brain proposals only. Input: ProposedTransition. Output: updated Process
  // Projection. No reasoning. No Brain mutation." A proposal is coordinated through the
  // exact same path as any request — the proposer is RECORDED, never allowed to bypass
  // confirmation or supply its own authorizing facts:
  //   - proposal.verification is DROPPED — verification is re-derived through the port
  //     (a proposer must never assert its own verification; that would authorize on trust).
  //   - proposal.proposedReadiness is KEPT as `observedReadiness` — it can only cause a
  //     staleness REJECTION, never an advance, so trusting it is safe.
  // -------------------------------------------------------------------------
  async submitProposal(
    organizationId: string,
    instanceId: string,
    proposal: ProposedTransition,
  ): Promise<OrchestrationResult> {
    return this.requestTransition({
      organizationId,
      instanceId,
      kind: proposal.kind,
      proposer: proposal.proposer,
      toPhaseKey: proposal.toPhaseKey ?? null,
      confirmed: proposal.confirmed,
      confirmedByUserId: proposal.confirmedByUserId ?? null,
      proposedByUserId: proposal.proposedByUserId ?? null,
      rationale: proposal.rationale ?? null,
      ...(proposal.proposedReadiness !== undefined ? { observedReadiness: proposal.proposedReadiness } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // projectionOf — projection retrieval (a read the orchestrator owns).
  // -------------------------------------------------------------------------
  async projectionOf(organizationId: string, instanceId: string): Promise<RuntimeState | null> {
    const ctx = await this.repository.loadInstanceContext(organizationId, instanceId);
    return ctx?.projection ?? null;
  }
}

// ===========================================================================
// Factory — make wiring a real integration trivial (inject real ports later).
// ===========================================================================
export function createBusinessProcessOrchestrator(
  repository: BusinessProcessRepository,
  ports: OrchestratorPorts = {},
): BusinessProcessOrchestrator {
  return new BusinessProcessOrchestrator({ repository, ...ports });
}

// ===========================================================================
// Pure helpers (no I/O)
// ===========================================================================

function phaseByKey(def: BusinessProcessDefinition, key: string | null | undefined): PhaseDefinition | null {
  if (key == null) return null;
  return def.phases.find((p) => p.key === key) ?? null;
}

// Map the runtime's structured guard result onto the orchestrator's typed error
// taxonomy. Classification reads guard.checks (structured booleans), not denial
// strings, in a fixed priority so the reason is deterministic.
//
// A wrinkle the PR A guard imposes: a `forward` from a LIVE phase is structurally
// illegal UNLESS that phase is already satisfied/verified — so "exit not verified"
// also shows up as `structurallyLegal: false`, indistinguishable by checks alone from
// a genuinely illegal move (e.g. `complete` from draft). The disambiguator is the
// orchestrator's OWN knowledge: if it asked the verification port and the verdict was
// negative, an unverified exit is the operative cause → VERIFICATION_FAILED, checked
// before the structural fallback. Confirmation is checked first (it is never a side
// effect of another gate). When all structural checks pass but the commit was still
// rejected, the only remaining runtime denial is the fresh-readiness staleness guard.
function classifyGuardFailure(
  guard: GuardResult,
  ctx: { verificationAsked: boolean; verificationVerdict: boolean },
): OrchestrationFailureReason {
  const c = guard.checks;
  if (!c.confirmationSatisfied) return 'CONFIRMATION_MISSING';
  if (ctx.verificationAsked && !ctx.verificationVerdict) return 'VERIFICATION_FAILED';
  if (!c.structurallyLegal) return 'ILLEGAL_TRANSITION';
  if (c.entryReady === false || c.entryReady === 'unknown') return 'NOT_READY';
  return 'NOT_READY';
}
