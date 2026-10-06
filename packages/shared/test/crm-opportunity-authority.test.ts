// The CRM Opportunity authority contract (PD-F-11, approved 2026-10-06; CRM slice 3).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CRM_OPPORTUNITY_ACTS,
  CRM_OPPORTUNITY_ACT_ROLES,
  CRM_RELATIONSHIP_ACT_ROLES,
  crmOpportunityActPermitted,
  crmOpportunityOwnerEligible,
} from '../src';

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR', 'UNKNOWN'] as const;

test('PD-F-11 as written: view all humans, create/update EMPLOYEE+, reopen MANAGER+, void OWNER/ADMIN, AI_EMPLOYEE nothing', () => {
  const expected: Record<string, readonly string[]> = {
    VIEW: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'],
    CREATE: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    UPDATE: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    CHANGE_OWNER: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    ADD_PARTICIPANT: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    END_PARTICIPANT: ['OWNER', 'ADMIN', 'MANAGER'],
    VOID_PARTICIPANT: ['OWNER', 'ADMIN'],
    REOPEN: ['OWNER', 'ADMIN', 'MANAGER'],
    VOID: ['OWNER', 'ADMIN'],
  };
  assert.deepEqual(Object.keys(CRM_OPPORTUNITY_ACT_ROLES).sort(), [...CRM_OPPORTUNITY_ACTS].sort());
  for (const act of CRM_OPPORTUNITY_ACTS) {
    for (const role of ROLES) {
      assert.equal(crmOpportunityActPermitted({ act, role, actorType: 'HUMAN' }), expected[act]!.includes(role), `${act} ${role}`);
      assert.equal(crmOpportunityActPermitted({ act, role, actorType: 'SYSTEM' }), false, `a machine never ${act}`);
    }
  }
  assert.equal(crmOpportunityActPermitted({ act: 'DELETE', role: 'OWNER', actorType: 'HUMAN' }), false, 'an unknown act fails closed');
});

test('the acts PD-F-11 does not name mirror PD-F-04 exactly (owner, participants)', () => {
  assert.deepEqual(CRM_OPPORTUNITY_ACT_ROLES.CHANGE_OWNER, CRM_RELATIONSHIP_ACT_ROLES.CHANGE_OWNER);
  assert.deepEqual(CRM_OPPORTUNITY_ACT_ROLES.ADD_PARTICIPANT, CRM_RELATIONSHIP_ACT_ROLES.ADD_PARTICIPANT);
  assert.deepEqual(CRM_OPPORTUNITY_ACT_ROLES.END_PARTICIPANT, CRM_RELATIONSHIP_ACT_ROLES.END_PARTICIPANT);
  assert.deepEqual(CRM_OPPORTUNITY_ACT_ROLES.VOID_PARTICIPANT, CRM_RELATIONSHIP_ACT_ROLES.VOID_PARTICIPANT);
});

test('only a role that may work an Opportunity may be accountable for one', () => {
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE']) assert.equal(crmOpportunityOwnerEligible(role), true, role);
  for (const role of ['READ_ONLY', 'AI_EMPLOYEE', 'CREATOR', 'UNKNOWN', '']) assert.equal(crmOpportunityOwnerEligible(role), false, role);
});
