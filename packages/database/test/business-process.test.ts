// Business Process Engine · PR A (Sprint 27C) — deterministic guard harness.
//
// Runs with the built-in Node test runner (node --import tsx --test). NO
// infrastructure: the contracts and guard policy are pure, so every case is a
// direct call with hand-built in-memory shapes. The decisions pinned here are the
// ones the whole engine will rest on: which transitions are legal, that exit
// verification and entry readiness gate advancement, that 'unknown' never
// advances, that regression/reopen honor the definition, and that the evaluator
// is deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateTransition,
  isTransitionLegal,
  isConfirmationRequired,
  isRegressionAllowed,
  isReopenAllowed,
  isEntryReady,
  isExitVerified,
  nextAdvanceablePhaseKey,
  type GuardResult,
} from '../src/process-engine/business-process.policy';
import {
  TRANSITION_KINDS,
  type BusinessProcessDefinition,
  type BusinessProcessInstance,
  type PhaseState,
  type ProcessState,
  type Transition,
  type GuardFacts,
} from '../src/process-engine/business-process.contracts';

// --- fixtures --------------------------------------------------------------
function makeDef(overrides: Partial<BusinessProcessDefinition> = {}): BusinessProcessDefinition {
  return {
    key: 'BUYER_ONBOARDING',
    name: 'Buyer Onboarding',
    version: 1,
    objective: { key: 'ACQUIRE_BUYER' },
    subjectType: 'destination',
    allowBackward: true,
    allowRestart: true,
    phases: [
      { key: 'p1', name: 'Contract', position: 0, ownerResponsibilityKey: 'CONTRACT_REVIEW', applicability: 'always', reopenable: true, entryReadinessRef: null, exitVerificationRef: 'v_contract' },
      { key: 'p2', name: 'Setup', position: 1, ownerResponsibilityKey: 'CALLGRID_SETUP', applicability: 'always', reopenable: true, entryReadinessRef: 'r_setup', exitVerificationRef: 'v_setup' },
      { key: 'p3', name: 'Activation', position: 2, ownerResponsibilityKey: 'CALLGRID_OPTIMIZATION', applicability: 'always', reopenable: false, entryReadinessRef: 'r_activation', exitVerificationRef: 'v_activation' },
    ],
    ...overrides,
  };
}

function inst(
  state: ProcessState,
  currentPhaseKey: string | null,
  phaseStates: Record<string, PhaseState>,
): BusinessProcessInstance {
  return {
    definitionKey: 'BUYER_ONBOARDING',
    definitionVersion: 1,
    subject: { type: 'destination', label: 'Acme Roofing' },
    objective: { key: 'ACQUIRE_BUYER' },
    state,
    currentPhaseKey,
    phases: Object.entries(phaseStates).map(([phaseKey, s]) => ({ phaseKey, state: s })),
  };
}

const t = (kind: Transition['kind'], extra: Partial<Transition> = {}): Transition => ({
  kind,
  proposer: 'human',
  confirmed: true,
  ...extra,
});

// =====================================================================
// Legal / illegal transitions
// =====================================================================

test('initial forward from draft enters the first phase', () => {
  const def = makeDef();
  const i = inst('draft', null, { p1: 'pending', p2: 'pending', p3: 'pending' });
  assert.equal(nextAdvanceablePhaseKey(def, i), 'p1');
  const r = evaluateTransition({ definition: def, instance: i, transition: t('forward', { toPhaseKey: 'p1' }), facts: { entryReady: true } });
  assert.equal(r.decision, 'allow');
});

test('forward may NOT skip ahead — targeting a later phase is illegal', () => {
  const def = makeDef();
  const i = inst('draft', null, { p1: 'pending', p2: 'pending', p3: 'pending' });
  assert.equal(isTransitionLegal(def, i, t('forward', { toPhaseKey: 'p2' })), false);
  const r = evaluateTransition({ definition: def, instance: i, transition: t('forward', { toPhaseKey: 'p2' }), facts: { entryReady: true } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.checks.structurallyLegal, false);
});

test('an unrecognized transition from a terminal state is illegal', () => {
  const def = makeDef();
  const done = inst('completed', 'p3', { p1: 'exited', p2: 'exited', p3: 'verified' });
  assert.equal(isTransitionLegal(def, done, t('forward', { toPhaseKey: 'p3' })), false);
  assert.equal(isTransitionLegal(def, done, t('suspend')), false); // cannot suspend a completed process
});

// =====================================================================
// Guard evaluation — exit verified + entry ready + confirmation
// =====================================================================

test('advancing requires exit verified AND entry ready AND confirmation', () => {
  const def = makeDef();
  // p1 done (satisfied), advancing to p2.
  const base = () => inst('active', 'p1', { p1: 'satisfied', p2: 'pending', p3: 'pending' });

  const ok = evaluateTransition({ definition: def, instance: base(), transition: t('forward', { toPhaseKey: 'p2' }), facts: { exitVerified: true, entryReady: true } });
  assert.equal(ok.decision, 'allow');

  const noExit = evaluateTransition({ definition: def, instance: base(), transition: t('forward', { toPhaseKey: 'p2' }), facts: { exitVerified: false, entryReady: true } });
  assert.equal(noExit.decision, 'deny');
  assert.ok(noExit.denials.some((d) => /exit is not verified/.test(d)));

  const notReady = evaluateTransition({ definition: def, instance: base(), transition: t('forward', { toPhaseKey: 'p2' }), facts: { exitVerified: true, entryReady: false } });
  assert.equal(notReady.decision, 'deny');
  assert.ok(notReady.denials.some((d) => /not ready/.test(d)));

  const noConfirm = evaluateTransition({ definition: def, instance: base(), transition: t('forward', { toPhaseKey: 'p2', confirmed: false }), facts: { exitVerified: true, entryReady: true } });
  assert.equal(noConfirm.decision, 'deny');
  assert.ok(noConfirm.denials.some((d) => /requires explicit confirmation/.test(d)));
});

test('a phase that is only satisfied (not verified) cannot yet advance without the verdict', () => {
  const def = makeDef();
  const i = inst('active', 'p1', { p1: 'satisfied', p2: 'pending', p3: 'pending' });
  // exitVerified fact absent ⇒ Verification has not confirmed ⇒ deny.
  const r = evaluateTransition({ definition: def, instance: i, transition: t('forward', { toPhaseKey: 'p2' }), facts: { entryReady: true } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.checks.exitVerified, false);
});

// =====================================================================
// Unknown never advances
// =====================================================================

test('unknown entry readiness never advances a process', () => {
  const def = makeDef();
  const i = inst('active', 'p1', { p1: 'satisfied', p2: 'pending', p3: 'pending' });
  // entryReady omitted ⇒ 'unknown'.
  const r = evaluateTransition({ definition: def, instance: i, transition: t('forward', { toPhaseKey: 'p2' }), facts: { exitVerified: true } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.checks.entryReady, 'unknown');
  assert.ok(r.denials.some((d) => /unknown/.test(d)));
  assert.equal(isEntryReady({ entryReady: 'unknown' }), false);
  assert.equal(isEntryReady({}), false);
});

// =====================================================================
// Completion (terminal phase)
// =====================================================================

test('complete is legal only from a verified terminal phase', () => {
  const def = makeDef();
  const onTerminal = inst('active', 'p3', { p1: 'exited', p2: 'exited', p3: 'satisfied' });
  const ok = evaluateTransition({ definition: def, instance: onTerminal, transition: t('complete'), facts: { exitVerified: true } });
  assert.equal(ok.decision, 'allow');

  const notVerified = evaluateTransition({ definition: def, instance: onTerminal, transition: t('complete'), facts: { exitVerified: false } });
  assert.equal(notVerified.decision, 'deny');

  const notTerminal = inst('active', 'p2', { p1: 'exited', p2: 'satisfied', p3: 'pending' });
  assert.equal(isTransitionLegal(def, notTerminal, t('complete')), false);
});

// =====================================================================
// Regression (backward)
// =====================================================================

test('regression returns to an earlier completed phase only when the definition allows it', () => {
  const def = makeDef();
  const i = inst('active', 'p3', { p1: 'verified', p2: 'exited', p3: 'active' });
  assert.equal(isRegressionAllowed(def, i, 'p1'), true);
  const r = evaluateTransition({ definition: def, instance: i, transition: t('backward', { toPhaseKey: 'p1' }) });
  assert.equal(r.decision, 'allow');

  // forward-or-same target is not regression
  assert.equal(isRegressionAllowed(def, i, 'p3'), false);

  // disallowed by the definition
  const noBack = makeDef({ allowBackward: false });
  assert.equal(isRegressionAllowed(noBack, i, 'p1'), false);
  assert.equal(evaluateTransition({ definition: noBack, instance: i, transition: t('backward', { toPhaseKey: 'p1' }) }).decision, 'deny');
});

// =====================================================================
// Reopen
// =====================================================================

test('reopen is allowed only for a reopenable, verified/exited phase', () => {
  const def = makeDef();
  const i = inst('active', 'p2', { p1: 'verified', p2: 'active', p3: 'pending' });
  assert.equal(isReopenAllowed(def, i, 'p1'), true); // p1 reopenable + verified
  assert.equal(evaluateTransition({ definition: def, instance: i, transition: t('reopen', { toPhaseKey: 'p1' }) }).decision, 'allow');

  // p3 is not reopenable
  const j = inst('active', 'p3', { p1: 'exited', p2: 'exited', p3: 'exited' });
  assert.equal(isReopenAllowed(def, j, 'p3'), false);

  // a pending phase was never completed → cannot reopen
  assert.equal(isReopenAllowed(def, i, 'p3'), false);
});

// =====================================================================
// Suspend / Resume — operational, no confirmation required
// =====================================================================

test('suspend and resume are legal on the running/held states and need no confirmation', () => {
  const def = makeDef();
  const active = inst('active', 'p2', { p1: 'exited', p2: 'active', p3: 'pending' });
  const suspend = evaluateTransition({ definition: def, instance: active, transition: t('suspend', { confirmed: false }) });
  assert.equal(suspend.decision, 'allow');
  assert.equal(suspend.checks.confirmationRequired, false);

  const held = inst('on_hold', 'p2', { p1: 'exited', p2: 'active', p3: 'pending' });
  assert.equal(evaluateTransition({ definition: def, instance: held, transition: t('resume', { confirmed: false }) }).decision, 'allow');

  // resume is not legal from active
  assert.equal(isTransitionLegal(def, active, t('resume')), false);
});

// =====================================================================
// Terminal states — terminate / restart
// =====================================================================

test('terminate is legal from any running state and abandons the process', () => {
  const def = makeDef();
  for (const s of ['draft', 'initiated', 'active', 'on_hold'] as ProcessState[]) {
    const i = inst(s, s === 'draft' ? null : 'p1', { p1: 'active', p2: 'pending', p3: 'pending' });
    assert.equal(evaluateTransition({ definition: def, instance: i, transition: t('terminate') }).decision, 'allow', `terminate from ${s}`);
  }
});

test('restart is legal only from a terminal state and only when the definition allows it', () => {
  const def = makeDef();
  const abandoned = inst('abandoned', 'p2', { p1: 'exited', p2: 'active', p3: 'pending' });
  assert.equal(evaluateTransition({ definition: def, instance: abandoned, transition: t('restart') }).decision, 'allow');

  const active = inst('active', 'p2', { p1: 'exited', p2: 'active', p3: 'pending' });
  assert.equal(isTransitionLegal(def, active, t('restart')), false); // not terminal

  const noRestart = makeDef({ allowRestart: false });
  assert.equal(evaluateTransition({ definition: noRestart, instance: abandoned, transition: t('restart') }).decision, 'deny');
});

// =====================================================================
// Confirmation matrix
// =====================================================================

test('confirmation is required for business-changing kinds, not for holds', () => {
  const requires: Record<string, boolean> = {
    forward: true, backward: true, reopen: true, terminate: true, restart: true, complete: true,
    suspend: false, resume: false,
  };
  for (const kind of TRANSITION_KINDS) {
    assert.equal(isConfirmationRequired(kind), requires[kind], `confirmation for ${kind}`);
  }
});

// =====================================================================
// Pure fact predicates
// =====================================================================

test('exit-verified and entry-ready predicates only accept explicit truth', () => {
  assert.equal(isExitVerified({ exitVerified: true }), true);
  assert.equal(isExitVerified({ exitVerified: false }), false);
  assert.equal(isExitVerified({}), false);
  assert.equal(isEntryReady({ entryReady: true }), true);
  assert.equal(isEntryReady({ entryReady: false }), false);
});

// =====================================================================
// Determinism
// =====================================================================

test('evaluateTransition is deterministic for identical inputs', () => {
  const def = makeDef();
  const i = inst('active', 'p1', { p1: 'satisfied', p2: 'pending', p3: 'pending' });
  const transition = t('forward', { toPhaseKey: 'p2' });
  const facts: GuardFacts = { exitVerified: true, entryReady: true };
  const a: GuardResult = evaluateTransition({ definition: def, instance: i, transition, facts });
  const b: GuardResult = evaluateTransition({ definition: def, instance: i, transition, facts });
  assert.deepEqual(a, b);
});
