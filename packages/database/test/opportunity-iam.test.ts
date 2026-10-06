// The `opportunities` coarse gate in the RBAC matrix (PD-F-11, CRM slice 3). Pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matrixAllows, type Action } from '../src/repositories/iam.repository';

const ACTIONS: Action[] = ['view', 'create', 'update', 'delete', 'manage'];

test('`opportunities` grants view to every human role and no action beyond view; acts live in the act table', () => {
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const) {
    assert.equal(matrixAllows(role, 'opportunities', 'view'), true, `${role} view`);
    for (const action of ACTIONS.filter((a) => a !== 'view')) {
      assert.equal(matrixAllows(role, 'opportunities', action), false, `${role} ${action}`);
    }
  }
});

test('AI_EMPLOYEE and CREATOR hold nothing on Opportunities -- not even through the READ_ONLY fallback', () => {
  for (const action of ACTIONS) {
    assert.equal(matrixAllows('AI_EMPLOYEE', 'opportunities', action), false, `AI_EMPLOYEE ${action}`);
    assert.equal(matrixAllows('CREATOR', 'opportunities', action), false, `CREATOR ${action}`);
  }
});
