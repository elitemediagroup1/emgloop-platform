// Sprint 27C — Business Process Engine · PR A (Guard Policy)
// ---------------------------------------------------------------------------
// PURE, deterministic guard logic for the Business Process Engine. No I/O, no
// Prisma, no providers, no repositories, no database, no clock (timestamps are
// only ever injected via the contract shapes, never read here), no RNG. Given the
// same inputs these functions ALWAYS return the same result.
//
// Guard logic determines ONLY (per the approved Blueprint, PR A scope):
//   • Is the transition legal?        isTransitionLegal
//   • Is the exit verified?           isExitVerified
//   • Is the entry ready?             isEntryReady
//   • Is confirmation required?       isConfirmationRequired
//   • Is regression allowed?          isRegressionAllowed
//   • Is reopen allowed?              isReopenAllowed
// …and composes them into one decision: evaluateTransition. Nothing else. It does
// NOT mutate state, does NOT compute the resulting state (that reducer is PR B),
// does NOT derive readiness or verification (those are supplied as GuardFacts),
// and does NOT resolve responsibilities to users.
//
// Fail closed: anything unrecognized, missing, or ambiguous denies. `entryReady`
// of 'unknown' NEVER advances a process — absent evidence is not readiness.
// ---------------------------------------------------------------------------

import {
  type BusinessProcessDefinition,
  type BusinessProcessInstance,
  type PhaseDefinition,
  type PhaseInstance,
  type PhaseState,
  type ProcessState,
  type Transition,
  type TransitionKind,
  type GuardFacts,
  type Readiness,
} from './business-process.contracts';

// ===========================================================================
// Structural legality graphs
// ===========================================================================

// Process states from which each transition kind is structurally permitted.
// (Additional allowances — allowBackward / allowRestart — are checked separately.)
const PROCESS_LEGAL_FROM: Record<TransitionKind, readonly ProcessState[]> = {
  forward: ['draft', 'initiated', 'active'],
  complete: ['active'],
  suspend: ['initiated', 'active'],
  resume: ['on_hold'],
  terminate: ['draft', 'initiated', 'active', 'on_hold'],
  restart: ['completed', 'abandoned', 'archived'],
  backward: ['active'],
  reopen: ['active'],
};

// Transition kinds that require an explicit confirmation from an authorized actor.
// The business-changing and reversing moves require it; operational holds do not.
const TRANSITIONS_REQUIRING_CONFIRMATION: ReadonlySet<TransitionKind> = new Set<TransitionKind>([
  'forward',
  'backward',
  'reopen',
  'terminate',
  'restart',
  'complete',
]);

// ===========================================================================
// Small pure lookups
// ===========================================================================
function phaseDef(def: BusinessProcessDefinition, key: string | null | undefined): PhaseDefinition | null {
  if (key == null) return null;
  return def.phases.find((p) => p.key === key) ?? null;
}

function phaseInst(instance: BusinessProcessInstance, key: string | null | undefined): PhaseInstance | null {
  if (key == null) return null;
  return instance.phases.find((p) => p.phaseKey === key) ?? null;
}

const TERMINAL_PHASE_STATES: ReadonlySet<PhaseState> = new Set<PhaseState>(['skipped', 'exited']);

// The terminal phase of a definition = the one with the greatest position.
function terminalPhaseKey(def: BusinessProcessDefinition): string | null {
  if (def.phases.length === 0) return null;
  return def.phases.reduce((a, b) => (b.position > a.position ? b : a)).key;
}

// The next phase to advance INTO: the lowest-position phase strictly after the
// current position whose stored state is not terminal. For the initial entry
// (no current phase) it is the first non-terminal phase by position. This is what
// makes "no skipping ahead" structural — forward may only target this phase.
export function nextAdvanceablePhaseKey(
  def: BusinessProcessDefinition,
  instance: BusinessProcessInstance,
): string | null {
  const currentDef = phaseDef(def, instance.currentPhaseKey);
  const floor = currentDef ? currentDef.position : -Infinity;
  const candidates = def.phases
    .filter((p) => p.position > floor)
    .sort((a, b) => a.position - b.position);
  for (const p of candidates) {
    const inst = phaseInst(instance, p.key);
    // A phase with no instance row yet, or a non-terminal one, is advanceable.
    if (!inst || !TERMINAL_PHASE_STATES.has(inst.state)) return p.key;
  }
  return null;
}

// ===========================================================================
// The six guard determinations (each pure; each answers exactly one question)
// ===========================================================================

// (1) Is the transition legal? — structural legality only: the transition kind is
// permitted from the current process state AND (for phase-affecting kinds) the
// phase pointers are in a coherent state. Facts/confirmation are checked elsewhere.
export function isTransitionLegal(
  def: BusinessProcessDefinition,
  instance: BusinessProcessInstance,
  transition: Transition,
): boolean {
  const kind = transition.kind;
  if (!PROCESS_LEGAL_FROM[kind]?.includes(instance.state)) return false;

  switch (kind) {
    case 'forward': {
      // Must target exactly the next advanceable phase (no skipping).
      const next = nextAdvanceablePhaseKey(def, instance);
      if (next == null || transition.toPhaseKey !== next) return false;
      const current = phaseInst(instance, instance.currentPhaseKey);
      // Initial entry (no current phase) is legal from draft; otherwise the current
      // phase must be at least satisfied (work done) before advancing.
      if (current == null) return instance.currentPhaseKey == null;
      return current.state === 'satisfied' || current.state === 'verified';
    }
    case 'complete': {
      const current = phaseInst(instance, instance.currentPhaseKey);
      const terminal = terminalPhaseKey(def);
      if (current == null || instance.currentPhaseKey !== terminal) return false;
      return current.state === 'satisfied' || current.state === 'verified';
    }
    case 'backward': {
      if (!def.allowBackward) return false;
      return isRegressionAllowed(def, instance, transition.toPhaseKey);
    }
    case 'reopen':
      return isReopenAllowed(def, instance, transition.toPhaseKey);
    case 'restart':
      return def.allowRestart;
    case 'suspend':
    case 'resume':
    case 'terminate':
      return true; // process-level; the state-graph check above is sufficient
    default:
      return false; // fail closed on any unrecognized kind
  }
}

// (2) Is the exit verified? — the Verification verdict for the current phase.
// Supplied, never derived. Undefined ⇒ not verified.
export function isExitVerified(facts: GuardFacts): boolean {
  return facts.exitVerified === true;
}

// (3) Is the entry ready? — the Readiness conclusion for the target phase.
// Supplied, never derived. Only an explicit `true` is ready; false and (crucially)
// 'unknown'/undefined are not. Unknown never advances a process.
export function isEntryReady(facts: GuardFacts): boolean {
  return facts.entryReady === true;
}

export function entryReadinessOf(facts: GuardFacts): Readiness {
  return facts.entryReady ?? 'unknown';
}

// (4) Is confirmation required for this kind?
export function isConfirmationRequired(kind: TransitionKind): boolean {
  return TRANSITIONS_REQUIRING_CONFIRMATION.has(kind);
}

// (5) Is regression allowed? — backward is permitted only when the definition
// allows it and the target is a real, earlier phase in a completed state.
export function isRegressionAllowed(
  def: BusinessProcessDefinition,
  instance: BusinessProcessInstance,
  toPhaseKey: string | null | undefined,
): boolean {
  if (!def.allowBackward) return false;
  const target = phaseDef(def, toPhaseKey);
  const current = phaseDef(def, instance.currentPhaseKey);
  if (!target || !current) return false;
  if (target.position >= current.position) return false; // must move strictly back
  const targetInst = phaseInst(instance, target.key);
  if (!targetInst) return false;
  // Regress only into a phase that had been completed (verified/exited).
  return targetInst.state === 'verified' || targetInst.state === 'exited';
}

// (6) Is reopen allowed? — a verified/exited phase may reopen only if the
// definition marks it reopenable.
export function isReopenAllowed(
  def: BusinessProcessDefinition,
  instance: BusinessProcessInstance,
  toPhaseKey: string | null | undefined,
): boolean {
  const target = phaseDef(def, toPhaseKey);
  if (!target || target.reopenable !== true) return false;
  const targetInst = phaseInst(instance, target.key);
  if (!targetInst) return false;
  return targetInst.state === 'verified' || targetInst.state === 'exited';
}

// ===========================================================================
// Composite evaluation
// ===========================================================================
export interface GuardChecks {
  structurallyLegal: boolean;
  exitVerified: boolean | 'n/a';
  entryReady: Readiness | 'n/a';
  confirmationRequired: boolean;
  confirmationSatisfied: boolean;
  regressionAllowed: boolean | 'n/a';
  reopenAllowed: boolean | 'n/a';
}

export interface GuardResult {
  decision: 'allow' | 'deny';
  checks: GuardChecks;
  denials: string[]; // human-readable reasons; empty iff decision === 'allow'
}

export interface EvaluateTransitionInput {
  definition: BusinessProcessDefinition;
  instance: BusinessProcessInstance;
  transition: Transition;
  facts?: GuardFacts;
}

// Compose the six determinations into a single allow/deny decision. Deterministic:
// same (definition, instance, transition, facts) → same GuardResult. Every failed
// determination contributes a denial reason; the decision is allow iff no denials.
export function evaluateTransition(input: EvaluateTransitionInput): GuardResult {
  const { definition: def, instance, transition } = input;
  const facts: GuardFacts = input.facts ?? {};
  const kind = transition.kind;
  const denials: string[] = [];

  const structurallyLegal = isTransitionLegal(def, instance, transition);
  if (!structurallyLegal) {
    const phase = phaseInst(instance, instance.currentPhaseKey);
    denials.push(
      `illegal transition '${kind}' (process='${instance.state}', phase='${phase?.state ?? 'none'}')`,
    );
  }

  const confirmationRequired = isConfirmationRequired(kind);
  const confirmationSatisfied = !confirmationRequired || transition.confirmed === true;
  if (!confirmationSatisfied) denials.push(`transition '${kind}' requires explicit confirmation`);

  // Fact-dependent checks, per kind. Kinds without a fact dependency report 'n/a'.
  let exitVerified: boolean | 'n/a' = 'n/a';
  let entryReady: Readiness | 'n/a' = 'n/a';
  let regressionAllowed: boolean | 'n/a' = 'n/a';
  let reopenAllowed: boolean | 'n/a' = 'n/a';

  if (kind === 'forward') {
    // Initial entry (no current phase) has no exit to verify.
    const isInitialEntry = instance.currentPhaseKey == null;
    if (!isInitialEntry) {
      exitVerified = isExitVerified(facts);
      if (!exitVerified) denials.push('current phase exit is not verified');
    }
    entryReady = entryReadinessOf(facts);
    if (!isEntryReady(facts)) {
      denials.push(
        entryReady === 'unknown'
          ? 'target phase entry readiness is unknown — cannot advance'
          : 'target phase entry is not ready',
      );
    }
  } else if (kind === 'complete') {
    exitVerified = isExitVerified(facts);
    if (!exitVerified) denials.push('terminal phase exit is not verified');
  } else if (kind === 'backward') {
    regressionAllowed = isRegressionAllowed(def, instance, transition.toPhaseKey);
    if (!regressionAllowed) denials.push('regression is not allowed for this target');
  } else if (kind === 'reopen') {
    reopenAllowed = isReopenAllowed(def, instance, transition.toPhaseKey);
    if (!reopenAllowed) denials.push('reopen is not allowed for this target');
  }

  return {
    decision: denials.length === 0 ? 'allow' : 'deny',
    checks: {
      structurallyLegal,
      exitVerified,
      entryReady,
      confirmationRequired,
      confirmationSatisfied,
      regressionAllowed,
      reopenAllowed,
    },
    denials,
  };
}
