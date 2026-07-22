// Start Work + Work Type registry — deterministic harness.
//
// Two layers, no infrastructure: (1) buildWorkSubmission is pure, so validation /
// owner resolution / Eastern due-date / requirements are direct calls; (2) the
// Work Type layer over Blueprint is exercised through the REAL WorkRepository
// against a tiny in-memory Prisma double for blueprints / blueprint_stages / users.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { WorkRepository } from '../src/repositories/work.repository';
import { buildWorkSubmission } from '../src/work-os/start-work';
import { WORK_TYPE_CATALOG, WORK_TYPE_CATEGORIES, RESPONSIBILITY_LABELS } from '../src/work-os/work-type-catalog';

// --- pure buildWorkSubmission ------------------------------------------------

const base = {
  workTypeId: 'wt1',
  title: 'Set up ABC Roofing as a new buyer',
  outcome: 'Create the buyer, load caps, confirm routing.',
  assignMode: 'unassigned' as const,
  priority: 'normal',
};

test('required fields are validated with field-level errors', () => {
  const r = buildWorkSubmission({ ...base, workTypeId: '', title: '', outcome: '' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.workTypeId && r.errors.title && r.errors.outcome);
  }
});

test('unassigned is valid and yields no owner', () => {
  const r = buildWorkSubmission({ ...base, assignMode: 'unassigned' });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.firstOwnerUserId, null);
});

test('specific assignment requires a chosen member', () => {
  const bad = buildWorkSubmission({ ...base, assignMode: 'specific', assigneeUserId: '' });
  assert.equal(bad.ok, false);
  const good = buildWorkSubmission({ ...base, assignMode: 'specific', assigneeUserId: 'user_7' });
  assert.ok(good.ok);
  if (good.ok) assert.equal(good.value.firstOwnerUserId, 'user_7');
});

test('auto assignment resolves to the work type default assignee', () => {
  const r = buildWorkSubmission({ ...base, assignMode: 'auto', workTypeDefaultAssigneeUserId: 'default_owner' });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.firstOwnerUserId, 'default_owner');
});

test('due date/time is interpreted in America/New_York (DST-aware)', () => {
  // July 1, 2025 09:00 ET = 13:00 UTC (EDT, -4).
  const summer = buildWorkSubmission({ ...base, dueDate: '2025-07-01', dueTime: '09:00' });
  assert.ok(summer.ok);
  if (summer.ok) {
    assert.equal(summer.value.metadata.dueAt, '2025-07-01T13:00:00.000Z');
    assert.equal(summer.value.metadata.dueTimezone, 'America/New_York');
  }
  // Jan 1, 2025 09:00 ET = 14:00 UTC (EST, -5).
  const winter = buildWorkSubmission({ ...base, dueDate: '2025-01-01', dueTime: '09:00' });
  if (winter.ok) assert.equal(winter.value.metadata.dueAt, '2025-01-01T14:00:00.000Z');
});

test('a due time without a due date is rejected', () => {
  const r = buildWorkSubmission({ ...base, dueTime: '09:00' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.dueTime);
});

test('requirements are trimmed and empty ones dropped; responsibility + relation recorded', () => {
  const r = buildWorkSubmission({
    ...base,
    responsibility: 'CALLGRID_SETUP',
    relationType: 'buyer',
    relationLabel: 'ABC Roofing',
    requirements: [
      { name: 'Signed IO received', required: true },
      { name: '   ', required: false },
      { name: 'Destination specs received', description: 'from buyer', required: false },
    ],
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.metadata.requirements.length, 2);
    assert.equal(r.value.metadata.requirements[0]!.required, true);
    assert.equal(r.value.metadata.responsibility, 'CALLGRID_SETUP');
    assert.deepEqual(r.value.metadata.relation, { type: 'buyer', label: 'ABC Roofing' });
  }
});

// --- catalog integrity -------------------------------------------------------

test('the approved catalog covers every category and maps to real responsibilities', () => {
  assert.ok(WORK_TYPE_CATALOG.length >= 40, 'the full approved catalog is present');
  const cats = new Set(WORK_TYPE_CATALOG.map((c) => c.category));
  for (const c of WORK_TYPE_CATEGORIES) assert.ok(cats.has(c), `category ${c} has starter types`);
  for (const c of WORK_TYPE_CATALOG) {
    assert.ok(RESPONSIBILITY_LABELS[c.responsibility], `${c.name} maps to a labelled responsibility`);
  }
  assert.equal(new Set(WORK_TYPE_CATALOG.map((c) => c.key)).size, WORK_TYPE_CATALOG.length, 'keys unique');
});

// --- Work Type repository over an in-memory Blueprint store ------------------

type Row = Record<string, unknown>;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond !== null && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(v);
      if ('not' in c) return v !== c.not;
      return false;
    }
    return v === cond;
  });
}
function table() {
  const rows: Row[] = [];
  let n = 0;
  return {
    rows,
    async create({ data }: { data: Row }) {
      const row = { id: `id_${++n}`, metadata: {}, description: null, status: 'active', createdAt: new Date(), ...data };
      rows.push(row); return row;
    },
    async findMany({ where, select }: { where?: Row; select?: Row }) {
      let out = where ? rows.filter((r) => matches(r, where)) : [...rows];
      if (select) out = out.map((r) => { const o: Row = {}; for (const k of Object.keys(select)) o[k] = r[k]; return o; });
      return out;
    },
    async findFirst({ where }: { where: Row }) { return rows.find((r) => matches(r, where)) ?? null; },
    async findUnique({ where }: { where: Row }) { return rows.find((r) => matches(r, where)) ?? null; },
    async update({ where, data }: { where: Row; data: Row }) {
      const r = rows.find((x) => matches(x, where)); if (!r) throw new Error('not found');
      Object.assign(r, data); return r;
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      let c = 0; for (const r of rows) if (matches(r, where)) { Object.assign(r, data); c++; } return { count: c };
    },
  };
}
function makeRepo() {
  const blueprint = table();
  const blueprintStage = table();
  const user = table();
  const prisma = { blueprint, blueprintStage, user } as unknown as PrismaClient;
  return { repo: new WorkRepository(prisma), blueprint, blueprintStage, user };
}
const ORG = 'org_a';

test('createWorkType makes a Blueprint plus one startable stage', async () => {
  const { repo, blueprint, blueprintStage } = makeRepo();
  await repo.createWorkType({ organizationId: ORG, createdByUserId: 'u1', name: 'Buyer Setup', category: 'CallGrid Operations', responsibility: 'CALLGRID_SETUP' });
  assert.equal(blueprint.rows.length, 1);
  assert.equal(blueprintStage.rows.length, 1, 'a default stage exists so work can be started');
  const types = await repo.listWorkTypes(ORG);
  assert.equal(types.length, 1);
  assert.equal(types[0]!.category, 'CallGrid Operations');
  assert.equal(types[0]!.responsibility, 'CALLGRID_SETUP');
});

test('a legacy Blueprint with no work-type metadata still lists as a Work Type', async () => {
  const { repo, blueprint } = makeRepo();
  await blueprint.create({ data: { organizationId: ORG, name: 'Legacy Flow', createdByUserId: 'u1', status: 'active' } });
  const types = await repo.listWorkTypes(ORG);
  assert.equal(types.length, 1);
  assert.equal(types[0]!.category, 'General'); // sensible default, retained
});

test('installStarterWorkTypes is idempotent — a second run creates nothing', async () => {
  const { repo } = makeRepo();
  const catalog = WORK_TYPE_CATALOG.map((c) => ({ key: c.key, name: c.name, category: c.category, responsibility: c.responsibility, defaultPriority: c.defaultPriority }));
  const first = await repo.installStarterWorkTypes(ORG, 'u1', catalog);
  assert.equal(first.created, catalog.length);
  const second = await repo.installStarterWorkTypes(ORG, 'u1', catalog);
  assert.equal(second.created, 0);
  assert.equal(second.skipped, catalog.length);
  assert.equal((await repo.listWorkTypes(ORG)).length, catalog.length);
});

test('deactivating a Work Type removes it from the active list but keeps it', async () => {
  const { repo } = makeRepo();
  const bp = await repo.createWorkType({ organizationId: ORG, createdByUserId: 'u1', name: 'Old Type' });
  await repo.setWorkTypeActive(ORG, bp.id, false);
  assert.equal((await repo.listWorkTypes(ORG)).length, 0, 'hidden from new work');
  assert.equal((await repo.listWorkTypes(ORG, { includeInactive: true })).length, 1, 'still exists for admin');
});

test('listActiveMembers excludes INVITED, DISABLED and other-org users', async () => {
  const { repo, user } = makeRepo();
  await user.create({ data: { organizationId: ORG, name: 'Active One', email: 'a@x.io', status: 'ACTIVE' } });
  await user.create({ data: { organizationId: ORG, name: 'Pending', email: 'p@x.io', status: 'INVITED' } });
  await user.create({ data: { organizationId: ORG, name: 'Gone', email: 'g@x.io', status: 'DISABLED' } });
  await user.create({ data: { organizationId: 'org_b', name: 'Other', email: 'o@x.io', status: 'ACTIVE' } });
  const members = await repo.listActiveMembers(ORG);
  assert.deepEqual(members.map((m) => m.email), ['a@x.io']);
});
