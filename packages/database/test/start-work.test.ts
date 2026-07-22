// Start Work + Work Type registry — deterministic harness.
//
// Two layers, no infrastructure: (1) buildWorkItemSubmission is pure, so
// universal-field / custom-field / Eastern-target / step validation are direct
// calls; (2) the Work Type layer over Blueprint is exercised through the REAL
// WorkRepository against a tiny in-memory Prisma double for blueprints /
// blueprint_stages / users.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { WorkRepository } from '../src/repositories/work.repository';
import { buildWorkItemSubmission } from '../src/work-os/start-work';
import type { WorkflowStepDef, WorkFieldDef } from '../src/work-os/workflow';
import { WORK_TYPE_CATALOG, WORK_TYPE_CATEGORIES, RESPONSIBILITY_LABELS } from '../src/work-os/work-type-catalog';

// --- pure buildWorkItemSubmission --------------------------------------------

const step = (over: Partial<WorkflowStepDef> = {}): WorkflowStepDef => ({
  name: 'Review details',
  instruction: 'Confirm everything is correct.',
  assignment: { mode: 'creator' },
  completionConfirmation: null,
  completionNote: 'none',
  notifyActive: true,
  notifyComplete: false,
  ...over,
});

const base = {
  title: 'Set up ABC Roofing as a new buyer',
  outcome: 'Create the buyer, load caps, confirm routing.',
  priority: 'normal',
  steps: [step()],
};

test('required universal fields are validated with field-level errors', () => {
  const r = buildWorkItemSubmission({ ...base, title: '', outcome: '' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.title && r.errors.outcome);
});

test('a single valid step is accepted and carried through', () => {
  const r = buildWorkItemSubmission(base);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.steps.length, 1);
});

test('an empty step list is rejected (a Work Item needs at least one step)', () => {
  const r = buildWorkItemSubmission({ ...base, steps: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.steps && r.errors.steps.length > 0);
});

test('a specific step with no member is a per-step assignee error', () => {
  const r = buildWorkItemSubmission({ ...base, steps: [step({ assignment: { mode: 'specific', specificUserId: '' } })] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors.steps?.[0]?.errors.assignee !== undefined, true);
});

test('target date/time is interpreted in America/New_York (DST-aware)', () => {
  // July 1, 2025 09:00 ET = 13:00 UTC (EDT, -4).
  const summer = buildWorkItemSubmission({ ...base, targetDate: '2025-07-01', targetTime: '09:00', useTime: true });
  assert.ok(summer.ok);
  if (summer.ok) {
    assert.equal(summer.value.targetAtUtc, '2025-07-01T13:00:00.000Z');
    assert.equal(summer.value.dueTimezone, 'America/New_York');
    assert.equal(summer.value.targetEastern, '2025-07-01 09:00');
  }
  // Jan 1, 2025 09:00 ET = 14:00 UTC (EST, -5).
  const winter = buildWorkItemSubmission({ ...base, targetDate: '2025-01-01', targetTime: '09:00', useTime: true });
  if (winter.ok) assert.equal(winter.value.targetAtUtc, '2025-01-01T14:00:00.000Z');
});

test('a date with no time defaults to 17:00 ET end-of-business', () => {
  const r = buildWorkItemSubmission({ ...base, targetDate: '2025-07-01' });
  assert.ok(r.ok);
  // 17:00 ET (EDT) = 21:00 UTC.
  if (r.ok) {
    assert.equal(r.value.targetAtUtc, '2025-07-01T21:00:00.000Z');
    assert.equal(r.value.targetEastern, '2025-07-01 17:00');
  }
});

test('a target time toggled on without a date is rejected', () => {
  const r = buildWorkItemSubmission({ ...base, targetTime: '09:00', useTime: true });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.targetTime);
});

test('custom fields: required-missing errors, present values are cleaned and kept', () => {
  const fields: WorkFieldDef[] = [
    { key: 'payout', label: 'Payout', type: 'currency', required: true, sortOrder: 0, active: true },
    { key: 'contact', label: 'Primary contact', type: 'short_text', required: false, sortOrder: 1, active: true },
    { key: 'gone', label: 'Retired', type: 'short_text', required: true, sortOrder: 2, active: false },
  ];
  const bad = buildWorkItemSubmission({ ...base, fields, fieldValues: { contact: '  Jane  ' } });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.fields?.payout, 'required payout flagged');
    assert.equal(bad.errors.fields?.gone, undefined, 'inactive field never required');
  }
  const good = buildWorkItemSubmission({ ...base, fields, fieldValues: { payout: '250', contact: '  Jane  ' } });
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.value.customFieldValues.payout, '250');
    assert.equal(good.value.customFieldValues.contact, 'Jane', 'trimmed');
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

test('setWorkTypeFields persists custom fields and preserves the rest of the metadata bag', async () => {
  const { repo } = makeRepo();
  const bp = await repo.createWorkType({ organizationId: ORG, createdByUserId: 'u1', name: 'Buyer', category: 'CallGrid Operations', responsibility: 'CALLGRID_SETUP' });
  await repo.setWorkTypeFields(ORG, bp.id, [
    { key: 'payout', label: 'Payout', type: 'currency', required: true, sortOrder: 0, active: true },
    { key: 'contact', label: 'Primary contact', type: 'short_text', required: false, sortOrder: 1, active: true },
  ]);
  const [t] = await repo.listWorkTypes(ORG, { includeInactive: true });
  assert.equal(t!.fields.length, 2);
  assert.equal(t!.fields[0]!.key, 'payout');
  assert.equal(t!.category, 'CallGrid Operations', 'category survived the fields write');
  assert.equal(t!.responsibility, 'CALLGRID_SETUP', 'responsibility survived');
});

test('setWorkTypeFields is a no-op for a cross-org id (fail closed)', async () => {
  const { repo } = makeRepo();
  const bp = await repo.createWorkType({ organizationId: ORG, createdByUserId: 'u1', name: 'Buyer' });
  await repo.setWorkTypeFields('org_other', bp.id, [{ key: 'x', label: 'X', type: 'short_text', required: false, sortOrder: 0, active: true }]);
  const [t] = await repo.listWorkTypes(ORG, { includeInactive: true });
  assert.equal(t!.fields.length, 0, 'cross-org write did nothing');
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
