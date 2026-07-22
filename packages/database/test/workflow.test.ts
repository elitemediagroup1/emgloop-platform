// Configurable sequential workflow — pure core harness.
//
// The owner-resolution engine, member de-duplication, custom-field parsing and
// step validation are all pure, so every rule is a direct call. No infrastructure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStepOwner,
  dedupeActiveMembers,
  readFieldDefs,
  validateWorkflowSteps,
  participantsOf,
  STEP_ASSIGN_MODES,
  WORK_FIELD_TYPES,
  type WorkflowStepDef,
} from '../src/work-os/workflow';

const ACTIVE = new Set(['u_creator', 'u_charlie', 'u_setup', 'u_prev']);

// ---- assignment modes (7, 14, 15, 16, 17) ----------------------------------

test('specific mode resolves to the chosen active member', () => {
  assert.equal(resolveStepOwner({ mode: 'specific', specificUserId: 'u_charlie' }, { creatorUserId: 'u_creator', activeMemberIds: ACTIVE }), 'u_charlie');
});

test('creator mode resolves to the Work Item creator (covers "Myself")', () => {
  assert.equal(resolveStepOwner({ mode: 'creator' }, { creatorUserId: 'u_creator', activeMemberIds: ACTIVE }), 'u_creator');
});

test('previous mode resolves to whoever completed the previous step', () => {
  assert.equal(resolveStepOwner({ mode: 'previous' }, { creatorUserId: 'u_creator', previousCompleterUserId: 'u_prev', activeMemberIds: ACTIVE }), 'u_prev');
  // at creation there is no previous completer yet → unassigned
  assert.equal(resolveStepOwner({ mode: 'previous' }, { creatorUserId: 'u_creator', activeMemberIds: ACTIVE }), null);
});

test('responsibility mode resolves through the org responsibility→owner map', () => {
  const owners = { CALLGRID_SETUP: 'u_setup' };
  assert.equal(resolveStepOwner({ mode: 'responsibility', responsibilityKey: 'CALLGRID_SETUP' }, { creatorUserId: 'u_creator', responsibilityOwners: owners, activeMemberIds: ACTIVE }), 'u_setup');
  // unowned responsibility → Needs an Owner (never fabricated)
  assert.equal(resolveStepOwner({ mode: 'responsibility', responsibilityKey: 'UNMAPPED' }, { creatorUserId: 'u_creator', responsibilityOwners: owners, activeMemberIds: ACTIVE }), null);
});

test('unassigned mode always yields Needs an Owner', () => {
  assert.equal(resolveStepOwner({ mode: 'unassigned' }, { creatorUserId: 'u_creator', activeMemberIds: ACTIVE }), null);
});

test('a resolved owner who is no longer active is dropped to unassigned (fail closed)', () => {
  // 9 & 10: removed/disabled member can never be handed a step
  assert.equal(resolveStepOwner({ mode: 'specific', specificUserId: 'u_removed' }, { creatorUserId: 'u_creator', activeMemberIds: ACTIVE }), null);
});

test('every approved assignment mode is handled', () => {
  for (const mode of STEP_ASSIGN_MODES) {
    // does not throw, returns string|null
    const r = resolveStepOwner({ mode, specificUserId: 'u_charlie', responsibilityKey: 'CALLGRID_SETUP' }, { creatorUserId: 'u_creator', previousCompleterUserId: 'u_prev', responsibilityOwners: { CALLGRID_SETUP: 'u_setup' }, activeMemberIds: ACTIVE });
    assert.ok(r === null || typeof r === 'string');
  }
});

// ---- de-duplication (8, 9, 10, 11, 12, 13) ---------------------------------

test('assignee list excludes non-active and collapses duplicates by identity', () => {
  const rows = [
    { id: 'm1', email: 'Matt@Emgloop.com', name: 'Matt Dunn', status: 'ACTIVE' },
    { id: 'm1', email: 'matt@emgloop.com', name: 'Matt Dunn', status: 'ACTIVE' }, // same id → dup
    { id: 'm2', email: 'MATT@emgloop.com', name: 'Matt Dunn', status: 'ACTIVE' }, // same email (diff case) → dup
    { id: 'morgan', email: 'manager@emgloop.com', name: 'Morgan Manager', status: 'DISABLED' },
    { id: 'riley', email: 'viewer@emgloop.com', name: 'Riley Viewer', status: 'DISABLED' },
    { id: 'real', email: 'charlie@emgloop.com', name: 'Charlie', status: 'ACTIVE' },
  ];
  const out = dedupeActiveMembers(rows);
  const names = out.map((r) => r.name);
  assert.ok(!names.includes('Morgan Manager'), 'Morgan (disabled) excluded');
  assert.ok(!names.includes('Riley Viewer'), 'Riley (disabled) excluded');
  assert.equal(names.filter((n) => n === 'Matt Dunn').length, 1, 'Matt Dunn appears exactly once');
  assert.deepEqual(out.map((r) => r.id), ['m1', 'real']);
});

test('genuinely distinct accounts (different emails) both remain', () => {
  const out = dedupeActiveMembers([
    { id: 'a', email: 'a@x.io', name: 'Same Name', status: 'ACTIVE' },
    { id: 'b', email: 'b@x.io', name: 'Same Name', status: 'ACTIVE' },
  ]);
  assert.equal(out.length, 2, 'not merged by display name — they are different identities');
});

// ---- custom fields (3) -----------------------------------------------------

test('custom field defs parse, validate types, and sort', () => {
  const defs = readFieldDefs([
    { key: 'payout', label: 'Payout', type: 'currency', required: true, sortOrder: 2 },
    { key: 'contact', label: 'Primary contact', type: 'email', sortOrder: 1 },
    { key: 'bogus', label: 'Bad type', type: 'not_a_type', sortOrder: 3 },
    { key: '', label: 'no key', type: 'short_text' }, // dropped
  ]);
  assert.deepEqual(defs.map((d) => d.key), ['contact', 'payout', 'bogus']);
  assert.equal(defs.find((d) => d.key === 'bogus')!.type, 'short_text', 'unknown type → safe default');
  assert.ok(WORK_FIELD_TYPES.includes(defs[0]!.type));
});

// ---- step validation (5, 6) ------------------------------------------------

function step(over: Partial<WorkflowStepDef>): WorkflowStepDef {
  return { name: 'Step', instruction: 'do it', assignment: { mode: 'creator' }, completionNote: 'none', notifyActive: true, notifyComplete: false, ...over };
}

test('a workflow needs at least one step; each step needs name + instruction', () => {
  assert.equal(validateWorkflowSteps([]).length, 1);
  const errs = validateWorkflowSteps([step({ name: '' }), step({ instruction: '' })]);
  assert.equal(errs.length, 2);
  assert.ok(errs[0]!.errors.name && errs[1]!.errors.instruction);
});

test('specific/responsibility steps require their target', () => {
  const errs = validateWorkflowSteps([
    step({ assignment: { mode: 'specific', specificUserId: '' } }),
    step({ assignment: { mode: 'responsibility', responsibilityKey: '' } }),
  ]);
  assert.equal(errs.length, 2);
  assert.ok(errs[0]!.errors.assignee && errs[1]!.errors.assignee);
});

test('a valid multi-step sequential workflow passes', () => {
  const errs = validateWorkflowSteps([
    step({ name: 'Buyer Details', assignment: { mode: 'creator' } }),
    step({ name: 'Prepare Agreements', assignment: { mode: 'specific', specificUserId: 'u_charlie' } }),
    step({ name: 'Configure', assignment: { mode: 'responsibility', responsibilityKey: 'CALLGRID_SETUP' } }),
    step({ name: 'Confirm Live', assignment: { mode: 'previous' } }),
  ]);
  assert.equal(errs.length, 0);
});

// ---- participants (22) -----------------------------------------------------

test('participants are the unique union of creator and step owners', () => {
  assert.deepEqual(
    participantsOf('u_creator', ['u_charlie', 'u_creator', null, 'u_setup', 'u_charlie']).sort(),
    ['u_charlie', 'u_creator', 'u_setup'],
  );
});
