// Identity authority, pure. Identity Slice 2.0.
//
// Pins every identity act to its identityResolution action and actor types
// (docs/architecture/identity-evidence-resolution.md section 6): update never
// establishes, approve is the only consequential boundary, AI performs nothing,
// a machine performs only flag proposals and extraction, and a MANAGER never
// confirms their own proposal (PD-I2-03). Agreement with the live grant table is
// held by packages/database/test/identity-2-0-agreement.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY_ACTS,
  IDENTITY_ACT_RULES,
  IDENTITY_ACTOR_TYPES,
  IDENTITY_ESTABLISHING_ACTION,
  identityActRule,
  identityActorTypePermitted,
  mayDecideProposal,
  type IdentityAct,
} from '../src/identity-authority';

const EXPECTED: Record<IdentityAct, string | null> = {
  VIEW_IDENTITY_STATE: 'view',
  RECORD_OPERATOR_IDENTIFICATION: 'create',
  PROPOSE_ATTRIBUTION: 'create',
  PROPOSE_CONTINUITY_ATTRIBUTION: 'create',
  CREATE_UNESTABLISHED_PARTY: 'create',
  CONFIRM_ATTRIBUTION: 'update',
  REJECT_ATTRIBUTION: 'update',
  REVERSE_ATTRIBUTION: 'update',
  PROPOSE_IDENTIFIER_FLAG: null,
  SET_IDENTIFIER_FLAG: 'update',
  DISMISS_IDENTIFIER_FLAG: 'update',
  REVOKE_IDENTIFIER_FLAG: 'update',
  ESTABLISH_PARTY: 'approve',
  LINK_INTAKE_TO_PARTY: 'approve',
  REVERSE_INTAKE_LINK: 'approve',
  CONFIRM_SAME_PARTY: 'approve',
  ACTIVATE_EVIDENCE_USE_POLICY: 'approve',
  ACTIVATE_MACHINE_POLICY: 'approve',
  EXTRACT_EVIDENCE: null,
};

test('every act has exactly its approved required action', () => {
  assert.deepEqual(Object.keys(IDENTITY_ACT_RULES).sort(), [...IDENTITY_ACTS].sort());
  for (const act of IDENTITY_ACTS) {
    const r = identityActRule(act);
    assert.equal(r.act, act);
    assert.equal(r.requiredAction, EXPECTED[act], act);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.actorTypes));
  }
  assert.ok(Object.isFrozen(IDENTITY_ACT_RULES));
});

test('AI performs no identity act, and unknown acts or actor types fail closed', () => {
  assert.deepEqual([...IDENTITY_ACTOR_TYPES], ['HUMAN', 'MACHINE', 'AI']);
  for (const act of IDENTITY_ACTS) {
    assert.equal(identityActorTypePermitted(act, 'AI'), false, act);
    assert.ok(!(identityActRule(act).actorTypes as readonly string[]).includes('AI'));
    assert.equal(identityActorTypePermitted(act, 'AI_EMPLOYEE'), false);
    assert.equal(identityActorTypePermitted(act, ''), false);
  }
  assert.equal(identityActorTypePermitted('MERGE_PEOPLE', 'HUMAN'), false);
});

test('a machine only proposes flags and extracts evidence; it never attributes, decides, links or establishes', () => {
  const machineActs = IDENTITY_ACTS.filter((a) => identityActorTypePermitted(a, 'MACHINE'));
  assert.deepEqual(machineActs, ['PROPOSE_IDENTIFIER_FLAG', 'EXTRACT_EVIDENCE']);
  for (const act of machineActs) {
    const r = identityActRule(act);
    assert.equal(r.requiredAction, null, 'no grant can let a person or AI perform a machine act');
    assert.equal(identityActorTypePermitted(act, 'HUMAN'), false);
    assert.equal(r.establishesIdentity, false);
    assert.equal(r.decidesProposal, false);
  }
});

test('update never establishes; approve is the only consequential identity boundary', () => {
  assert.equal(IDENTITY_ESTABLISHING_ACTION, 'approve');
  for (const act of IDENTITY_ACTS) {
    const r = identityActRule(act);
    if (r.establishesIdentity) assert.equal(r.requiredAction, 'approve', act);
    if (r.requiredAction !== 'approve') assert.equal(r.establishesIdentity, false, act);
  }
  const approveActs = IDENTITY_ACTS.filter((a) => identityActRule(a).requiredAction === 'approve');
  assert.deepEqual(approveActs, [
    'ESTABLISH_PARTY',
    'LINK_INTAKE_TO_PARTY',
    'REVERSE_INTAKE_LINK',
    'CONFIRM_SAME_PARTY',
    'ACTIVATE_EVIDENCE_USE_POLICY',
    'ACTIVATE_MACHINE_POLICY',
  ]);
});

test('reasons are required, and history kept, for every act that says no or undoes', () => {
  const reasoned = IDENTITY_ACTS.filter((a) => identityActRule(a).reasonRequired);
  assert.deepEqual(reasoned, [
    'REJECT_ATTRIBUTION',
    'REVERSE_ATTRIBUTION',
    'DISMISS_IDENTIFIER_FLAG',
    'REVOKE_IDENTIFIER_FLAG',
    'REVERSE_INTAKE_LINK',
    'CONFIRM_SAME_PARTY',
  ]);
  assert.equal(identityActRule('REVERSE_ATTRIBUTION').preservesHistory, true, 'PD-I2-02');
  assert.equal(identityActRule('CONFIRM_SAME_PARTY').preservesHistory, true);
});

test('PD-I2-03: a MANAGER never confirms their own attribution proposal', () => {
  const own = { act: 'CONFIRM_ATTRIBUTION' as const, deciderUserId: 'u1', proposerUserId: 'u1' };
  assert.equal(mayDecideProposal({ ...own, deciderRole: 'MANAGER' }), false);
  assert.equal(mayDecideProposal({ ...own, deciderRole: 'MANAGER', proposerUserId: 'u2' }), true);
  // OWNER and ADMIN stay under the approved authority model.
  assert.equal(mayDecideProposal({ ...own, deciderRole: 'OWNER' }), true);
  assert.equal(mayDecideProposal({ ...own, deciderRole: 'ADMIN' }), true);
  // Any other role that reached `update` through a Permission row fails closed.
  for (const role of ['EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', '', 'owner']) {
    assert.equal(mayDecideProposal({ ...own, deciderRole: role }), false, role);
  }
});

test('separation applies only to deciding acts, and never to a blank decider', () => {
  assert.equal(mayDecideProposal({ act: 'REJECT_ATTRIBUTION', deciderUserId: 'u1', deciderRole: 'MANAGER', proposerUserId: 'u1' }), true, 'withdrawing your own proposal');
  assert.equal(mayDecideProposal({ act: 'DISMISS_IDENTIFIER_FLAG', deciderUserId: 'u1', deciderRole: 'MANAGER', proposerUserId: null }), true, 'a machine proposal');
  assert.equal(mayDecideProposal({ act: 'ESTABLISH_PARTY', deciderUserId: 'u1', deciderRole: 'OWNER', proposerUserId: null }), false);
  assert.equal(mayDecideProposal({ act: 'CONFIRM_ATTRIBUTION', deciderUserId: '  ', deciderRole: 'OWNER', proposerUserId: 'u2' }), false);
});
