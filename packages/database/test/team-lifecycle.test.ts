// Team-member lifecycle — deterministic harness (Production Blocker).
//
// Runs with the built-in Node test runner (node --import tsx --test). NO
// infrastructure: a tiny in-memory Prisma double stands in for the `users` and
// `invitations` tables and, crucially, ENFORCES the real @@unique([organizationId,
// email]) constraint the way Postgres does (a second insert for the same
// org+email throws a P2002). That constraint is the whole reason the invite path
// broke — invite blindly ran user.create and the unhandled P2002 both crashed the
// Team page and blocked re-inviting a removed teammate. These tests drive the ACTUAL
// IamRepository against that constraint so the lifecycle is proven end-to-end:
// invite → pending → revoke/remove → reinvite, with exactly one membership row ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { IamRepository } from '../src/repositories/iam.repository';

// --- in-memory Prisma double ------------------------------------------------

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const val = row[key];
    if (cond !== null && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('not' in c) return val !== c['not'];
      if ('in' in c) return (c['in'] as unknown[]).includes(val);
      if ('gt' in c) return (val as Date).getTime() > (c['gt'] as Date).getTime();
      return false;
    }
    return val === cond;
  });
}

function makeTable(name: 'users' | 'invitations') {
  const rows: Row[] = [];
  let seq = 0;
  const nextId = () => `${name}_${++seq}`;

  const create = ({ data }: { data: Row }): Row => {
    // Enforce the users @@unique([organizationId, email]) — a duplicate insert
    // must throw a P2002, exactly like Postgres, so tests can prove the fix.
    if (name === 'users') {
      const dup = rows.find((r) => r['organizationId'] === data['organizationId'] && r['email'] === data['email']);
      if (dup) {
        const e = new Error('Unique constraint failed on the fields: (`organizationId`,`email`)') as Error & { code: string };
        e.code = 'P2002';
        throw e;
      }
    }
    const row: Row = {
      id: (data['id'] as string) ?? nextId(),
      metadata: {},
      name: null,
      lastLoginAt: null,
      acceptedAt: null,
      systemRole: 'EMPLOYEE', // the never-read Invitation column default
      createdAt: new Date(),
      ...data,
    };
    rows.push(row);
    return row;
  };

  return {
    _rows: rows,
    async findFirst({ where }: { where: Row }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async findMany({ where, orderBy }: { where: Row; orderBy?: { createdAt: 'asc' | 'desc' } }) {
      let out = rows.filter((r) => matches(r, where));
      if (orderBy?.createdAt) {
        out = [...out].sort((a, b) => {
          const d = (a['createdAt'] as Date).getTime() - (b['createdAt'] as Date).getTime();
          return orderBy.createdAt === 'desc' ? -d : d;
        });
      }
      return out;
    },
    async create(args: { data: Row }) {
      return create(args);
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error('record not found');
      Object.assign(row, data);
      return row;
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      let count = 0;
      for (const r of rows) {
        if (matches(r, where)) { Object.assign(r, data); count++; }
      }
      return { count };
    },
    async count({ where }: { where: Row }) {
      return rows.filter((r) => matches(r, where)).length;
    },
  };
}

function makeIam() {
  const user = makeTable('users');
  const invitation = makeTable('invitations');
  const prisma = { user, invitation } as unknown as PrismaClient;
  return { iam: new IamRepository(prisma), user, invitation };
}

const ORG = 'org_a';

// Mirror acceptInviteAction's repository choice: reuse the existing (org,email)
// row and flip it ACTIVE — never a second membership.
async function accept(iam: IamRepository, user: ReturnType<typeof makeTable>, email: string) {
  const existing = user._rows.find((r) => r['organizationId'] === ORG && r['email'] === email);
  assert.ok(existing, 'invite must have created the membership row');
  await iam.activateUser(ORG, existing!['id'] as string);
  return existing!['id'] as string;
}

// --- 1. invite a brand-new email -------------------------------------------

test('invite a new email creates exactly one INVITED membership + a PENDING invite', async () => {
  const { iam, user } = makeIam();
  const outcome = await iam.prepareInvitation({ organizationId: ORG, email: 'new@x.io', systemRole: 'MANAGER' });
  assert.ok(outcome.ok && outcome.reused === false, 'a brand-new row, not a reinstatement');
  await iam.createInvitation({ organizationId: ORG, email: 'new@x.io', systemRole: 'MANAGER', inviterId: 'inv', tokenHash: 'h1' });

  assert.equal(user._rows.filter((r) => r['email'] === 'new@x.io').length, 1);
  const row = user._rows.find((r) => r['email'] === 'new@x.io')!;
  assert.equal(row['status'], 'INVITED');
  const invites = await iam.listInvitations(ORG);
  assert.equal(invites.length, 1);
  assert.equal(invites[0]!.systemRole, 'MANAGER'); // role from metadata, not the column
});

// --- 2 & 9. blocks ----------------------------------------------------------

test('a still-valid pending invitation blocks a duplicate invite (resend instead)', async () => {
  const { iam } = makeIam();
  await iam.prepareInvitation({ organizationId: ORG, email: 'p@x.io', systemRole: 'EMPLOYEE' });
  await iam.createInvitation({ organizationId: ORG, email: 'p@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 'h1' });

  const again = await iam.prepareInvitation({ organizationId: ORG, email: 'p@x.io', systemRole: 'EMPLOYEE' });
  assert.deepEqual(again, { ok: false, reason: 'pending_exists' });
});

test('an active member blocks a duplicate invitation', async () => {
  const { iam, user } = makeIam();
  await iam.prepareInvitation({ organizationId: ORG, email: 'a@x.io', systemRole: 'EMPLOYEE' });
  await iam.createInvitation({ organizationId: ORG, email: 'a@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 'h1' });
  await accept(iam, user, 'a@x.io');

  const again = await iam.prepareInvitation({ organizationId: ORG, email: 'a@x.io', systemRole: 'EMPLOYEE' });
  assert.deepEqual(again, { ok: false, reason: 'active_member' });
});

// --- 3,4,5. resend / revoke / revoked-token rejection -----------------------

test('resend supersedes: old token dies, exactly one live PENDING remains', async () => {
  const { iam } = makeIam();
  await iam.prepareInvitation({ organizationId: ORG, email: 'r@x.io', systemRole: 'EMPLOYEE' });
  const first = await iam.createInvitation({ organizationId: ORG, email: 'r@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 'old' });

  // resend = revoke the pending + issue a fresh token
  await iam.revokeInvitation(ORG, first.id);
  await iam.createInvitation({ organizationId: ORG, email: 'r@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 'fresh' });

  const invites = await iam.listInvitations(ORG);
  assert.equal(invites.length, 1, 'only the fresh invite is pending');
  assert.equal(await iam.findInvitationByToken('old'), null, 'the revoked token is rejected');
  assert.notEqual(await iam.findInvitationByToken('fresh'), null, 'the fresh token works');
});

test('a revoked pending invitation disappears from the list and its token is rejected', async () => {
  const { iam } = makeIam();
  await iam.prepareInvitation({ organizationId: ORG, email: 'v@x.io', systemRole: 'EMPLOYEE' });
  const inv = await iam.createInvitation({ organizationId: ORG, email: 'v@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 'tok' });
  await iam.revokeInvitation(ORG, inv.id);

  assert.equal((await iam.listInvitations(ORG)).length, 0);
  assert.equal(await iam.findInvitationByToken('tok'), null);
});

// --- 6,15,16,17. reinvite after revoke, exactly one membership --------------

test('reinvite after revocation reuses the SAME row — never a duplicate', async () => {
  const { iam, user } = makeIam();
  const first = await iam.prepareInvitation({ organizationId: ORG, email: 'dup@x.io', systemRole: 'EMPLOYEE' });
  const firstId = first.ok ? first.userId : '';
  const inv = await iam.createInvitation({ organizationId: ORG, email: 'dup@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 't1' });
  await iam.revokeInvitation(ORG, inv.id);

  // reinvite the same email with a DIFFERENT role
  const second = await iam.prepareInvitation({ organizationId: ORG, email: 'dup@x.io', systemRole: 'ADMIN' });
  assert.ok(second.ok && second.reused, 'the existing row is reinstated');
  assert.equal(second.ok ? second.userId : '', firstId, 'same membership row id — no second account');
  assert.equal(user._rows.filter((r) => r['email'] === 'dup@x.io').length, 1, 'still exactly one row');
  const row = user._rows.find((r) => r['email'] === 'dup@x.io')!;
  assert.equal(row['status'], 'INVITED');
  assert.equal((row['metadata'] as Row)['systemRole'], 'ADMIN', 'role refreshed to the new selection');
});

test('accepting the invitation leaves exactly one ACTIVE membership and no stale pending', async () => {
  const { iam, user } = makeIam();
  await iam.prepareInvitation({ organizationId: ORG, email: 'acc@x.io', systemRole: 'EMPLOYEE' });
  const inv = await iam.createInvitation({ organizationId: ORG, email: 'acc@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 't' });

  const row = user._rows.find((r) => r['email'] === 'acc@x.io')!;
  await iam.activateUser(ORG, row['id'] as string);
  await iam.acceptInvitation(inv.id);

  assert.equal(user._rows.filter((r) => r['email'] === 'acc@x.io' && r['status'] === 'ACTIVE').length, 1);
  assert.equal((await iam.listInvitations(ORG)).length, 0, 'no pending invite remains after acceptance');
});

// --- 10,12,13,14. disable / remove / reinvite removed -----------------------

test('disable keeps the member visible (reactivatable); remove hides them but keeps the row', async () => {
  const { iam, user } = makeIam();
  await iam.prepareInvitation({ organizationId: ORG, email: 'd@x.io', systemRole: 'EMPLOYEE' });
  await iam.createInvitation({ organizationId: ORG, email: 'd@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 't' });
  const id = user._rows.find((r) => r['email'] === 'd@x.io')!['id'] as string;
  await iam.activateUser(ORG, id);

  await iam.disableUser(ORG, id);
  let roster = await iam.listUsers(ORG);
  assert.equal(roster.find((u) => u.email === 'd@x.io')?.status, 'DISABLED', 'disabled members stay on the roster');

  await iam.softRemoveUser(ORG, id);
  roster = await iam.listUsers(ORG);
  assert.equal(roster.find((u) => u.email === 'd@x.io'), undefined, 'removed members drop off the roster');
  assert.equal(user._rows.filter((r) => r['email'] === 'd@x.io').length, 1, 'the row is preserved for history/reinstatement');
});

test('reinvite a REMOVED member reinstates the same row, clears the removed marker + stale password', async () => {
  const { iam, user } = makeIam();
  await iam.prepareInvitation({ organizationId: ORG, email: 'rm@x.io', systemRole: 'EMPLOYEE' });
  const inv = await iam.createInvitation({ organizationId: ORG, email: 'rm@x.io', systemRole: 'EMPLOYEE', inviterId: 'inv', tokenHash: 't' });
  const id = user._rows.find((r) => r['email'] === 'rm@x.io')!['id'] as string;
  // a real accepted member: activate + consume the invite (no lingering PENDING),
  // set a password, then remove.
  await iam.activateUser(ORG, id);
  await iam.acceptInvitation(inv.id);
  const row = user._rows.find((r) => r['email'] === 'rm@x.io')!;
  (row['metadata'] as Row)['passwordHash'] = 'stale-hash';
  await iam.softRemoveUser(ORG, id);
  assert.ok((row['metadata'] as Row)['removedAt'], 'removed marker set');

  const out = await iam.prepareInvitation({ organizationId: ORG, email: 'rm@x.io', systemRole: 'MANAGER' });
  assert.ok(out.ok && out.reused && out.userId === id, 'same row reinstated');
  assert.equal(row['status'], 'INVITED');
  assert.equal((row['metadata'] as Row)['removedAt'], undefined, 'removed marker cleared');
  assert.equal((row['metadata'] as Row)['passwordHash'], undefined, 'stale password dropped — must accept afresh');
  assert.equal((row['metadata'] as Row)['systemRole'], 'MANAGER');
});

// --- 18,19. mixed-state roster + org scoping --------------------------------

test('the Team page data loads with a mix of active/disabled/removed/invited/pending/revoked', async () => {
  const { iam, user } = makeIam();
  const seed = async (email: string, role: string, token: string) => {
    await iam.prepareInvitation({ organizationId: ORG, email, systemRole: role });
    const inv = await iam.createInvitation({ organizationId: ORG, email, systemRole: role, inviterId: 'i', tokenHash: token });
    const id = user._rows.find((r) => r['email'] === email)!['id'] as string;
    return { id, inv };
  };
  // active — accepted (invite consumed)
  const a = await seed('active@x.io', 'ADMIN', 'a');
  await iam.activateUser(ORG, a.id); await iam.acceptInvitation(a.inv.id);
  // disabled — accepted then disabled
  const d = await seed('disabled@x.io', 'EMPLOYEE', 'b');
  await iam.activateUser(ORG, d.id); await iam.acceptInvitation(d.inv.id); await iam.disableUser(ORG, d.id);
  // removed — accepted then removed
  const r = await seed('removed@x.io', 'EMPLOYEE', 'c');
  await iam.activateUser(ORG, r.id); await iam.acceptInvitation(r.inv.id); await iam.softRemoveUser(ORG, r.id);
  // pending — invited, not accepted
  await seed('pending@x.io', 'EMPLOYEE', 'd');

  const roster = await iam.listUsers(ORG);
  const emails = roster.map((u) => u.email).sort();
  // active + disabled only; removed hidden; invited(pending) not a member yet
  assert.deepEqual(emails, ['active@x.io', 'disabled@x.io']);
  const invites = await iam.listInvitations(ORG);
  assert.deepEqual(invites.map((i) => i.email).sort(), ['pending@x.io']);
});

test('every operation is organization-scoped — no cross-tenant read or write', async () => {
  const { iam, user } = makeIam();
  const OTHER = 'org_b';
  await iam.prepareInvitation({ organizationId: OTHER, email: 'them@x.io', systemRole: 'ADMIN' });
  await iam.createInvitation({ organizationId: OTHER, email: 'them@x.io', systemRole: 'ADMIN', inviterId: 'i', tokenHash: 'x' });
  const otherId = user._rows.find((r) => r['organizationId'] === OTHER)!['id'] as string;

  // org_a sees nothing of org_b
  assert.equal((await iam.listUsers(ORG)).length, 0);
  assert.equal((await iam.listInvitations(ORG)).length, 0);
  // an org_a caller cannot revoke org_b's invite or mutate org_b's user
  await iam.softRemoveUser(ORG, otherId); // wrong org → no-op
  assert.equal(user._rows.find((r) => r['id'] === otherId)!['status'], 'INVITED', 'cross-org write did not happen');

  // same email is a DIFFERENT membership in org_a (per-org uniqueness)
  const mine = await iam.prepareInvitation({ organizationId: ORG, email: 'them@x.io', systemRole: 'EMPLOYEE' });
  assert.ok(mine.ok && !mine.reused, 'a fresh row in org_a, independent of org_b');
});
