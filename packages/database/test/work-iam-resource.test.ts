// Work becomes a real IAM resource, and nobody's access changes. Work IAM slice.
//
// A2 could not ship a Work activity adapter: `activity.v1` requires every item to
// state a `resource:action` a server re-checks, and Work OS was guarded by workspace
// role alone. The fix is a real resource, and the whole risk of a fix like that is
// that somebody quietly gains or loses access on the way.
//
// SO THE PROPERTY UNDER TEST IS EQUIVALENCE, ROLE BY ROLE.
//
// `work` means ONE capability: the organization's work execution as a whole -- what
// the /app/admin/work tree carries. That tree admits exactly the roles resolving to
// the ADMIN workspace (OWNER, ADMIN, MANAGER), so exactly those roles hold `work`.
//
// It deliberately does NOT mean "act on my own assigned queue". An employee
// completing their stage holds no resource and never did: that flows from
// assignment, through the employee tree, whose guard this slice does not touch.
// Granting EMPLOYEE `work:view` would hand every employee a view of all of the
// organization's work -- which no role has today outside the admin tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository, matrixAllows, type Action } from '../src/repositories/iam.repository';
import { ActivityService } from '../src/services/activity.service';
import { WorkActivityAdapter, workActivityItem } from '../src/repositories/activity/work.adapter';

const ORG_A = 'org_a';
const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE'] as const;

/** SystemRole -> WorkspaceRole, transcribed from apps/web/src/workspaces/role-router.ts. */
const WORKSPACE_OF: Record<string, string> = {
  OWNER: 'ADMIN',
  ADMIN: 'ADMIN',
  MANAGER: 'ADMIN',
  EMPLOYEE: 'EMPLOYEE',
  AI_EMPLOYEE: 'EMPLOYEE',
  READ_ONLY: 'CLIENT',
};

test('the roles that hold `work` are exactly the roles the admin work tree admits', () => {
  // requireWorkspace('ADMIN') is an EXACT match, so the tree admits a role if and
  // only if it resolves to the ADMIN workspace. `work` is granted on the same rule.
  for (const role of ROLES) {
    const opensTheTree = WORKSPACE_OF[role] === 'ADMIN';
    assert.equal(matrixAllows(role, 'work', 'view'), opensTheTree, `${role} view`);
    assert.equal(matrixAllows(role, 'work', 'manage'), opensTheTree, `${role} manage`);
  }
  // Said plainly, so a future edit has to argue with it.
  assert.deepEqual(
    ROLES.filter((r) => matrixAllows(r, 'work', 'view')),
    ['OWNER', 'ADMIN', 'MANAGER'],
  );
});

test('no role gains any other access, and no role loses any', () => {
  // Every resource except `work` answers exactly as it did before this slice. The
  // expectation below is the matrix as it stood on main, transcribed.
  const before: Record<string, Record<string, Action[]>> = {
    OWNER: { customers: ['view', 'create', 'update', 'delete', 'manage'], audit: ['view', 'create', 'update', 'delete', 'manage'], intelligence: ['view', 'create', 'update', 'delete', 'manage'] },
    ADMIN: { customers: ['view', 'create', 'update', 'delete', 'manage'], audit: ['view'], intelligence: ['view', 'create', 'update', 'delete', 'manage'] },
    MANAGER: { customers: ['view', 'create', 'update'], audit: ['view'], intelligence: ['view'] },
    EMPLOYEE: { customers: ['view', 'create', 'update'], audit: [], intelligence: ['view'] },
    READ_ONLY: { customers: ['view'], audit: [], intelligence: ['view'] },
    AI_EMPLOYEE: { customers: ['view'], audit: [], intelligence: ['view'] },
  };
  for (const [role, resources] of Object.entries(before)) {
    for (const [resource, actions] of Object.entries(resources)) {
      for (const action of ['view', 'create', 'update', 'delete', 'manage'] as Action[]) {
        assert.equal(
          matrixAllows(role, resource as never, action),
          actions.includes(action),
          `${role} ${resource}:${action} must be unchanged`,
        );
      }
    }
  }
});

test('an employee acting on their own queue holds no resource, and gains none here', () => {
  // The employee work tree is guarded by requireWorkspace('EMPLOYEE') and this slice
  // does not touch it: an employee's own queue is reached exactly as before. What
  // they must NOT get is the organization-wide capability.
  for (const role of ['EMPLOYEE', 'AI_EMPLOYEE'] as const) {
    assert.equal(WORKSPACE_OF[role], 'EMPLOYEE', 'their tree is unchanged');
    assert.equal(matrixAllows(role, 'work', 'view'), false, `${role} does not see all of the organization's work`);
  }
});

test('READ_ONLY and AI_EMPLOYEE hold no work capability, as today', () => {
  for (const role of ['READ_ONLY', 'AI_EMPLOYEE'] as const) {
    for (const action of ['view', 'create', 'update', 'delete', 'manage'] as Action[]) {
      assert.equal(matrixAllows(role, 'work', action), false, `${role} ${action}`);
    }
  }
});

test('the work activity lane admits exactly the admin work tree\'s viewers', async () => {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'workStageEvent', 'brainEvent', 'brainJob'] });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const service = new ActivityService(prisma);

  await fake.workStageEvent.create({
    data: {
      id: 'wse_1', organizationId: ORG_A, workInstanceId: 'wi_1', workStageId: 'ws_1', eventType: 'STATE_CHANGED',
      sequence: 1, occurredAt: new Date('2026-09-16T10:00:00.000Z'), createdAt: new Date('2026-09-16T10:00:00.000Z'),
      fromStatus: 'ready', toStatus: 'in_progress', actorType: 'HUMAN', actorUserId: 'user_1', source: 'work-os',
      note: 'started on it', waitReason: null, waitSubject: null,
    },
  });

  const hire = async (role: string) => {
    const u = await iam.createUser({ organizationId: ORG_A, email: `${role.toLowerCase()}@x.io`, systemRole: role });
    await iam.activateUser(ORG_A, u.id);
    return u.id;
  };
  const subject = { kind: 'WORK_ITEM', workInstanceId: 'wi_1' } as const;

  for (const role of ROLES) {
    const userId = await hire(role);
    const result = await service.read({ organizationId: ORG_A, userId, workspaceRole: WORKSPACE_OF[role] }, subject);
    const admitted = WORKSPACE_OF[role] === 'ADMIN';
    assert.equal(result.outcome, admitted ? 'OK' : 'NOT_AUTHORIZED', `${role}`);
    if (result.outcome === 'OK') {
      assert.deepEqual(result.value.items.map((i) => i.key), ['work-stage-event:wse_1:1']);
    }
  }
});

test('a work item is never a person, and its operator notes stay in the source', () => {
  const item = workActivityItem({
    id: 'wse_1', organizationId: ORG_A, workInstanceId: 'wi_1', workStageId: 'ws_1', eventType: 'STATE_CHANGED',
    sequence: 4, occurredAt: new Date('2026-09-16T10:00:00.000Z'), createdAt: new Date('2026-09-16T10:00:01.000Z'),
    fromStatus: 'ready', toStatus: 'in_progress', waitReason: null, waitSubject: 'the client to send artwork',
    expectedResolutionAt: null, dueAt: null, dependencyId: null, actorType: 'HUMAN', actorUserId: 'user_9',
    source: 'work-os', note: 'called Dana on 555-0101 about it',
  } as never);

  assert.deepEqual(item.identity, { state: 'NOT_APPLICABLE', basis: 'NONE' });
  assert.equal(item.subjects.some((s) => s.kind === 'PARTY'), false);
  assert.deepEqual(item.subjects, [{ kind: 'WORK_ITEM', id: 'wi_1' }]);
  assert.deepEqual(item.participants, [{ kind: 'USER', id: 'user_9' }]);
  assert.equal(item.category, 'WORK');
  assert.deepEqual(item.display.stateChange, { from: 'ready', to: 'in_progress' });
  assert.deepEqual(item.access.requires, [{ resource: 'work', action: 'view' }]);
  assert.equal(item.access.workspace, 'ADMIN');
  // The note named a person and a phone number. Neither crosses.
  const serialized = JSON.stringify(item);
  assert.doesNotMatch(serialized, /Dana|555-0101|artwork/);
  assert.equal(item.sensitivity.rawValuesInSource, true);
  assert.ok(item.provenance.limitations.some((l) => l.includes('not logged consistently')), 'the lane admits it is incomplete');
});

test('`relationships` grants view to every human role, and no action beyond view', () => {
  // The coarse gate. Consequential acts are governed by CRM_RELATIONSHIP_ACT_ROLES,
  // which Product approved act by act -- so no matrix action beyond `view` exists to
  // be confused for one, and AI_EMPLOYEE holds nothing here at all.
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const) {
    assert.equal(matrixAllows(role, 'relationships', 'view'), true, `${role} view`);
    for (const action of ['create', 'update', 'delete', 'manage'] as Action[]) {
      assert.equal(matrixAllows(role, 'relationships', action), false, `${role} ${action}`);
    }
  }
  for (const action of ['view', 'create', 'update', 'delete', 'manage'] as Action[]) {
    assert.equal(matrixAllows('AI_EMPLOYEE', 'relationships', action), false, `AI_EMPLOYEE ${action}`);
  }
});

test('fence: this slice changed no route guard', () => {
  const root = join(__dirname, '..', '..', '..');
  // The work trees are still guarded exactly as they were. If a later slice moves
  // them onto `work:view`, it does so deliberately -- and for the employee tree that
  // needs a decision about AI_EMPLOYEE, which falls back to READ_ONLY in the matrix.
  const adminData = readFileSync(join(root, 'apps/web/src/app/app/admin/work/work-data.ts'), 'utf8');
  const employeeData = readFileSync(join(root, 'apps/web/src/app/app/employee/work/work-data.ts'), 'utf8');
  assert.match(adminData, /requireWorkspace\('ADMIN'\)/);
  assert.match(employeeData, /requireWorkspace\('EMPLOYEE'\)/);
  assert.doesNotMatch(employeeData, /requirePermission\('work'/, 'the employee tree is untouched by this slice');
});
