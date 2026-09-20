// sourceConnections is a real IAM resource, mirroring googleWorkspace exactly.
//
// Connecting a Teams/Telegram account is the same authority as connecting Google: every human
// role may hold their OWN connection (view+update), and AI_EMPLOYEE may never hold one -- not by
// the matrix, and not via a Permission row (the hard-deny in can()/canEach, exercised elsewhere).
// This pins the matrix half so the grant table cannot silently widen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matrixAllows, SOURCE_CONNECTION_GRANTS, GOOGLE_WORKSPACE_GRANTS, type Action } from '../src/repositories/iam.repository';

const HUMAN_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'];
const ALL_ACTIONS: Action[] = ['view', 'create', 'update', 'delete', 'manage', 'approve', 'send'];

test('sourceConnections grants exactly view+update to every human role, and nothing to AI_EMPLOYEE', () => {
  for (const role of HUMAN_ROLES) {
    assert.deepEqual([...(SOURCE_CONNECTION_GRANTS[role] ?? [])].sort(), ['update', 'view']);
    assert.equal(matrixAllows(role, 'sourceConnections', 'view'), true);
    assert.equal(matrixAllows(role, 'sourceConnections', 'update'), true);
    for (const action of ALL_ACTIONS) {
      if (action === 'view' || action === 'update') continue;
      assert.equal(matrixAllows(role, 'sourceConnections', action), false, `${role} must not hold ${action}`);
    }
  }
  // AI_EMPLOYEE holds nothing here, whatever a Permission row later says.
  assert.deepEqual([...(SOURCE_CONNECTION_GRANTS.AI_EMPLOYEE ?? [])], []);
  for (const action of ALL_ACTIONS) assert.equal(matrixAllows('AI_EMPLOYEE', 'sourceConnections', action), false);
});

test('sourceConnections mirrors googleWorkspace, role for role', () => {
  for (const role of [...HUMAN_ROLES, 'AI_EMPLOYEE']) {
    assert.deepEqual(
      [...(SOURCE_CONNECTION_GRANTS[role] ?? [])].sort(),
      [...(GOOGLE_WORKSPACE_GRANTS[role] ?? [])].sort(),
      `${role}: sourceConnections should mirror googleWorkspace`,
    );
  }
});
