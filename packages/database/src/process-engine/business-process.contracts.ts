// Sprint 27C — Business Process Engine · PR A (Canonical Contracts)
// ---------------------------------------------------------------------------
// The PERMANENT, provider-neutral domain contracts for the Business Process
// Engine — the platform layer between Operational Readiness and Work
// Intelligence. These types are the frozen shape every future process builds on.
//
// This file is CONTRACTS ONLY. It contains no logic, no I/O, no Prisma, no
// providers, and no persistence. Guard LOGIC lives in business-process.policy.ts;
// persistence, repositories, definitions, and wiring are later PRs (B/C/D).
//
// Boundary discipline encoded here (from the approved Phase A Blueprint):
//  - A Process owns SEQUENCE and POSITION. It references — never owns — evidence,
//    readiness results, work, verification verdicts, users, and memory.
//  - Responsibilities are referenced by KEY only. Never a user, assignment, or org.
//  - Objectives are referenced only (BusinessObjectiveReference). No storage here.
//  - Readiness / verification are referenced by key and supplied as FACTS to the
//    policy; this layer never derives them.
//  - `Blocked` (process) and `Blocked`/`Waiting` (phase) are DERIVED conditions,
//    not stored states — see the derived-condition vocabularies below.
// ---------------------------------------------------------------------------

// ===========================================================================
// Process lifecycle (frozen)
// ===========================================================================
// The lifecycle of the whole journey. `blocked` is intentionally ABSENT: it is a
// derived runtime condition of `active`, never a stored state (storing it would
// duplicate ownership with Readiness / Work Intelligence).
export const PROCESS_STATES = [
  'draft',
  'initiated',
  'active',
  'on_hold',
  'completed',
  'abandoned',
  'archived',
] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];

export const TERMINAL_PROCESS_STATES = ['completed', 'abandoned', 'archived'] as const;
export type TerminalProcessState = (typeof TERMINAL_PROCESS_STATES)[number];

// Derived (NOT stored) conditions a process may exhibit while `active`.
export const DERIVED_PROCESS_CONDITIONS = ['blocked'] as const;
export type DerivedProcessCondition = (typeof DERIVED_PROCESS_CONDITIONS)[number];

// ===========================================================================
// Phase lifecycle (frozen)
// ===========================================================================
// `blocked` and `waiting` are ABSENT here too — both are derived sub-states of
// `active`, reflected from Readiness (waiting) and Work Intelligence (blocked).
// `skipped` is a first-class stored state: a phase not applicable to the subject
// (the process-level analogue of Readiness's not-required ≠ missing).
export const PHASE_STATES = [
  'pending',
  'skipped',
  'eligible',
  'active',
  'satisfied',
  'verified',
  'exited',
  'reopened',
] as const;
export type PhaseState = (typeof PHASE_STATES)[number];

export const TERMINAL_PHASE_STATES = ['skipped', 'exited'] as const;
export type TerminalPhaseState = (typeof TERMINAL_PHASE_STATES)[number];

// Derived (NOT stored) conditions a phase may exhibit while `active`.
export const DERIVED_PHASE_CONDITIONS = ['blocked', 'waiting'] as const;
export type DerivedPhaseCondition = (typeof DERIVED_PHASE_CONDITIONS)[number];

// ===========================================================================
// Transitions (frozen verb set)
// ===========================================================================
export const TRANSITION_KINDS = [
  'forward', // advance to the next phase (also performs first entry: draft → initiated)
  'backward', // regress to an earlier phase because a later phase invalidated it
  'reopen', // re-activate a verified/exited phase whose verification became untrue
  'suspend', // hold the whole process
  'resume', // lift a hold
  'terminate', // abandon before completion
  'restart', // begin anew for the subject, preserving prior history
  'complete', // reach + verify the terminal phase
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

// Who proposed a transition. The engine records the proposer; it never lets a
// non-human proposer bypass confirmation for a business-changing move.
export const TRANSITION_PROPOSERS = ['brain', 'human', 'rule'] as const;
export type TransitionProposer = (typeof TRANSITION_PROPOSERS)[number];

// A requested transition. This is the POLICY input, not a persisted row (PR B
// owns the transition log). `toPhaseKey` is required for phase-targeting kinds
// (forward / backward / reopen) and ignored otherwise.
export interface Transition {
  kind: TransitionKind;
  proposer: TransitionProposer;
  toPhaseKey?: string | null;
  confirmed?: boolean; // whether an authorized actor confirmed (see policy)
  reason?: string | null;
}

// ===========================================================================
// References out of the engine (owned elsewhere)
// ===========================================================================

// A reference to a Business Objective. The engine supports references ONLY —
// objective storage and services live above the engine (Phase A §5). A process
// exists because an objective does; the objective outlives any single process.
export interface BusinessObjectiveReference {
  key: string; // e.g. 'ACQUIRE_BUYER' — a stable objective key, resolved elsewhere
  label?: string | null;
}

// Soft attribution for what a process is ABOUT. Deliberately not a canonical
// entity — no Buyer/Vendor/Customer row is required or created (WORK_INTELLIGENCE
// truth #4). Named by type + label + optional external id.
export interface ProcessSubject {
  type: string; // e.g. 'destination' | 'source' | 'invoice' — soft, open-ended
  label: string;
  externalId?: string | null;
}

// ===========================================================================
// Phase definition (template)
// ===========================================================================
// Applicability drives whether a phase can be `skipped`. 'always' phases are
// mandatory; 'conditional' phases may be skipped when not applicable to a subject.
export const PHASE_APPLICABILITIES = ['always', 'conditional'] as const;
export type PhaseApplicability = (typeof PHASE_APPLICABILITIES)[number];

export interface PhaseDefinition {
  key: string; // stable machine key, unique within the definition
  name: string;
  position: number; // 0-based order within the definition; determines sequence
  // Phase-level sub-objective — WHY this phase exists (free text; not a reference).
  objective?: string | null;
  // Accountability by responsibility KEY only. Never a user; resolution is external.
  ownerResponsibilityKey: string;
  // A reference to a Readiness requirement-set (by key). null ⇒ no entry gate.
  // The engine never derives readiness; it is supplied as a fact to the policy.
  entryReadinessRef?: string | null;
  // A reference to a Verification spec (by key). null ⇒ no exit verification.
  exitVerificationRef?: string | null;
  // Declarative expected outcomes ("a signed IO"). Not work items.
  expectedOutcomes?: string[];
  applicability: PhaseApplicability;
  // Whether a verified/exited instance of this phase may be reopened.
  reopenable: boolean;
  metadata?: Record<string, unknown>;
}

// ===========================================================================
// Process definition (template)
// ===========================================================================
// Immutable once published; a running instance PINS its version so a later edit
// never mutates in-flight processes. Authoring a new business process means
// authoring one of these as DATA — the engine never changes.
export interface BusinessProcessDefinition {
  key: string; // stable machine key, e.g. 'BUYER_ONBOARDING'
  name: string;
  version: number; // monotonically increasing; instances pin the version
  objective: BusinessObjectiveReference;
  subjectType: string; // the kind of subject this process is about
  phases: PhaseDefinition[]; // ordered by `position`
  // Whether backward (regression) transitions are permitted at all.
  allowBackward: boolean;
  // Whether the process may be restarted from a terminal state.
  allowRestart: boolean;
  metadata?: Record<string, unknown>;
}

// ===========================================================================
// Runtime instances (the shapes the policy reasons over)
// ===========================================================================
// NOTE: these are IN-MEMORY contract shapes for the pure policy. PR A adds no
// persistence — there is no id, no organizationId, and no transition log here.
// PR B introduces the durable representation and org-scoping.

export interface PhaseInstance {
  phaseKey: string;
  state: PhaseState;
  // Timestamps are SUPPLIED (injected), never generated here — the policy stays
  // clock-free. Present for completeness of the reasoning shape.
  enteredAt?: Date | null;
  satisfiedAt?: Date | null;
  verifiedAt?: Date | null;
  exitedAt?: Date | null;
  reopenedCount?: number;
}

export interface BusinessProcessInstance {
  definitionKey: string;
  definitionVersion: number;
  subject: ProcessSubject;
  objective: BusinessObjectiveReference;
  state: ProcessState;
  // Pointer to the phase currently in focus. null before the first entry (draft).
  currentPhaseKey: string | null;
  // Per-phase lifecycle position — POSITION ONLY. No evidence, no work, no verdicts.
  phases: PhaseInstance[];
}

// ===========================================================================
// Guard facts — inputs SUPPLIED by other layers (never derived here)
// ===========================================================================
// The engine derives none of these. Readiness supplies `entryReady`; Verification
// supplies `exitVerified`. `entryReady` is a tri-state on purpose: 'unknown' must
// NEVER advance a process (absent evidence is not readiness).
export type Readiness = boolean | 'unknown';

export interface GuardFacts {
  // Verification verdict for the CURRENT phase's exit criteria. Undefined ⇒ absent.
  exitVerified?: boolean;
  // Readiness conclusion for the TARGET phase's entry gate. Undefined ⇒ 'unknown'.
  entryReady?: Readiness;
}
