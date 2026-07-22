// Configurable sequential workflow — engine harness (repository level).
//
// A small in-memory Prisma double (with $transaction + `include: stages`) drives
// the REAL WorkRepository through the whole lifecycle: build a Work Item from a
// step list, hand off step by step resolving each owner by its mode, complete it,
// notify participants — plus save a workflow template and reuse it. No infra.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { WorkRepository } from '../src/repositories/work.repository';
import type { WorkflowStepDef } from '../src/work-os/workflow';

type Row = Record<string, any>;
function eq(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object') {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      return false;
    }
    return row[k] === v;
  });
}

function makeDb() {
  const t = { workInstance: [] as Row[], workStage: [] as Row[], workNotification: [] as Row[], workAssignment: [] as Row[], blueprint: [] as Row[], blueprintStage: [] as Row[] };
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const stagesOf = (wid: string) => t.workStage.filter((s) => s.workInstanceId === wid).sort((a, b) => a.position - b.position);
  const withStages = (inst: Row | undefined) => (inst ? { ...inst, stages: stagesOf(inst.id) } : inst);

  const prisma: any = {
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(prisma),
    workInstance: {
      create: async ({ data }: any) => { const r = { id: id('wi'), currentStageId: null, completedAt: null, description: null, metadata: {}, createdAt: new Date(), updatedAt: new Date(), ...data }; t.workInstance.push(r); return r; },
      findUnique: async ({ where, include }: any) => { const r = t.workInstance.find((x) => x.id === where.id); return include?.stages ? withStages(r) : r ?? null; },
      update: async ({ where, data, include }: any) => { const r = t.workInstance.find((x) => x.id === where.id); Object.assign(r, data); return include?.stages ? withStages(r) : r; },
    },
    workStage: {
      create: async ({ data }: any) => { const r = { id: id('ws'), ownerUserId: null, startedAt: null, completedAt: null, completedByUserId: null, description: null, metadata: {}, createdAt: new Date(), updatedAt: new Date(), ...data }; t.workStage.push(r); return r; },
      update: async ({ where, data }: any) => { const r = t.workStage.find((x) => x.id === where.id); Object.assign(r, data); return r; },
    },
    workNotification: { create: async ({ data }: any) => { const r = { id: id('wn'), readAt: null, metadata: {}, createdAt: new Date(), ...data }; t.workNotification.push(r); return r; } },
    workAssignment: { create: async ({ data }: any) => { const r = { id: id('wa'), assignedAt: new Date(), unassignedAt: null, metadata: {}, ...data }; t.workAssignment.push(r); return r; } },
    blueprint: {
      create: async ({ data }: any) => { const r = { id: id('bp'), status: 'active', description: null, metadata: {}, createdAt: new Date(), updatedAt: new Date(), ...data }; t.blueprint.push(r); return r; },
      findFirst: async ({ where, include }: any) => { const r = t.blueprint.find((b) => eq(b, where)); if (!r) return null; return include?.stages ? { ...r, stages: t.blueprintStage.filter((s) => s.blueprintId === r.id) } : r; },
      findMany: async ({ where, include }: any) => t.blueprint.filter((b) => eq(b, where)).map((r) => include?.stages ? { ...r, stages: t.blueprintStage.filter((s) => s.blueprintId === r.id) } : r),
      updateMany: async ({ where, data }: any) => { let c = 0; for (const b of t.blueprint) if (eq(b, where)) { Object.assign(b, data); c++; } return { count: c }; },
    },
    blueprintStage: {
      create: async ({ data }: any) => { const r = { id: id('bs'), description: null, defaultOwnerUserId: null, requiresApproval: false, metadata: {}, createdAt: new Date(), updatedAt: new Date(), ...data }; t.blueprintStage.push(r); return r; },
      deleteMany: async ({ where }: any) => { for (let i = t.blueprintStage.length - 1; i >= 0; i--) if (t.blueprintStage[i]!.blueprintId === where.blueprintId) t.blueprintStage.splice(i, 1); return { count: 0 }; },
    },
  };
  return { repo: new WorkRepository(prisma as unknown as PrismaClient), t };
}

const ORG = 'org_a';
const ACTIVE = new Set(['u_creator', 'u_charlie', 'u_setup']);

function step(over: Partial<WorkflowStepDef>): WorkflowStepDef {
  return { name: 'Step', instruction: 'do it', assignment: { mode: 'creator' }, completionNote: 'none', notifyActive: true, notifyComplete: false, ...over };
}

const BUYER_STEPS: WorkflowStepDef[] = [
  step({ name: 'Buyer Details', assignment: { mode: 'creator' } }),
  step({ name: 'Prepare Agreements', assignment: { mode: 'specific', specificUserId: 'u_charlie' } }),
  step({ name: 'Configure Buyer', assignment: { mode: 'responsibility', responsibilityKey: 'CALLGRID_SETUP' } }),
  step({ name: 'Confirm Live', assignment: { mode: 'previous' } }),
];

async function newBuyerWork(repo: WorkRepository) {
  return repo.createWorkItem({
    organizationId: ORG, creatorUserId: 'u_creator', workTypeId: 'wt_buyer', workTypeName: 'Buyer',
    title: 'Onboard ABC Roofing', outcome: 'Set them up end to end', priority: 'normal',
    steps: BUYER_STEPS, responsibilityOwners: { CALLGRID_SETUP: 'u_setup' }, activeMemberIds: ACTIVE,
  });
}

// ---- creation + handoff (18, 19, 20, 21, 22, 15, 16, 17) -------------------

test('only step 1 activates at creation; its owner is resolved and notified', async () => {
  const { repo, t } = makeDb();
  const wi = await newBuyerWork(repo);
  assert.equal(wi.stages[0]!.status, 'ready');
  assert.equal(wi.stages[0]!.ownerUserId, 'u_creator'); // creator mode
  assert.deepEqual(wi.stages.slice(1).map((s) => s.status), ['pending', 'pending', 'pending']);
  assert.equal(wi.currentStageId, wi.stages[0]!.id);
  const notifs = t.workNotification.filter((n) => n.userId === 'u_creator' && n.type === 'next_action_ready');
  assert.equal(notifs.length, 1, 'step-1 owner notified');
});

test('completing a step activates exactly the next and resolves its owner by mode', async () => {
  const { repo, t } = makeDb();
  let wi = await newBuyerWork(repo);
  // complete step 1 (creator) → step 2 (specific: Charlie) becomes ready + notified
  wi = await repo.completeWorkStep({ organizationId: ORG, workInstanceId: wi.id, stageId: wi.stages[0]!.id, completedByUserId: 'u_creator', activeMemberIds: ACTIVE, responsibilityOwners: { CALLGRID_SETUP: 'u_setup' } });
  assert.equal(wi.stages[0]!.status, 'completed');
  assert.equal(wi.stages[0]!.completedByUserId, 'u_creator');
  assert.equal(wi.stages[1]!.status, 'ready');
  assert.equal(wi.stages[1]!.ownerUserId, 'u_charlie');
  assert.deepEqual(wi.stages.slice(2).map((s) => s.status), ['pending', 'pending']);
  assert.equal(t.workNotification.filter((n) => n.userId === 'u_charlie').length, 1);
});

test('expectedOwnerUserId enforces owner-only completion at the data layer', async () => {
  const { repo } = makeDb();
  const wi = await newBuyerWork(repo); // step 1 is creator mode → owned by u_creator
  await assert.rejects(
    () => repo.completeWorkStep({ organizationId: ORG, workInstanceId: wi.id, stageId: wi.stages[0]!.id, completedByUserId: 'u_intruder', expectedOwnerUserId: 'u_intruder', activeMemberIds: ACTIVE }),
    /assigned owner/,
  );
  // The rightful owner still completes it.
  const done = await repo.completeWorkStep({ organizationId: ORG, workInstanceId: wi.id, stageId: wi.stages[0]!.id, completedByUserId: 'u_creator', expectedOwnerUserId: 'u_creator', activeMemberIds: ACTIVE, responsibilityOwners: { CALLGRID_SETUP: 'u_setup' } });
  assert.equal(done.stages[0]!.status, 'completed');
});

test('responsibility + previous-step-completer resolve dynamically at handoff', async () => {
  const { repo } = makeDb();
  let wi = await newBuyerWork(repo);
  const s = () => wi.stages;
  wi = await repo.completeWorkStep({ organizationId: ORG, workInstanceId: wi.id, stageId: s()[0]!.id, completedByUserId: 'u_creator', activeMemberIds: ACTIVE, responsibilityOwners: { CALLGRID_SETUP: 'u_setup' } });
  // step 2 (Charlie) completes → step 3 (responsibility CALLGRID_SETUP → u_setup)
  wi = await repo.completeWorkStep({ organizationId: ORG, workInstanceId: wi.id, stageId: s()[1]!.id, completedByUserId: 'u_charlie', activeMemberIds: ACTIVE, responsibilityOwners: { CALLGRID_SETUP: 'u_setup' } });
  assert.equal(s()[2]!.ownerUserId, 'u_setup', 'responsibility resolved');
  // step 3 completes → step 4 (previous) → whoever just completed step 3 (u_setup)
  wi = await repo.completeWorkStep({ organizationId: ORG, workInstanceId: wi.id, stageId: s()[2]!.id, completedByUserId: 'u_setup', activeMemberIds: ACTIVE, responsibilityOwners: { CALLGRID_SETUP: 'u_setup' } });
  assert.equal(s()[3]!.ownerUserId, 'u_setup', 'previous-completer resolved');
});

test('completing the final step completes the Work Item and notifies all participants', async () => {
  const { repo, t } = makeDb();
  let wi = await newBuyerWork(repo);
  for (let i = 0; i < 4; i++) {
    const stage = wi.stages[i]!;
    const completer = stage.ownerUserId ?? 'u_creator';
    wi = await repo.completeWorkStep({ organizationId: ORG, workInstanceId: wi.id, stageId: stage.id, completedByUserId: completer, activeMemberIds: ACTIVE, responsibilityOwners: { CALLGRID_SETUP: 'u_setup' } });
  }
  assert.equal(wi.status, 'completed');
  assert.ok(wi.completedAt);
  const notified = new Set(t.workNotification.filter((n) => n.type === 'completed').map((n) => n.userId));
  // participants: creator + charlie + setup
  assert.deepEqual([...notified].sort(), ['u_charlie', 'u_creator', 'u_setup']);
});

test('an unassigned step lands in Needs an Owner (null owner, still ready)', async () => {
  const { repo } = makeDb();
  const wi = await repo.createWorkItem({
    organizationId: ORG, creatorUserId: 'u_creator', workTypeId: 'wt', workTypeName: 'X',
    title: 'T', outcome: 'O', priority: 'normal',
    steps: [step({ assignment: { mode: 'unassigned' } })], activeMemberIds: ACTIVE,
  });
  assert.equal(wi.stages[0]!.status, 'ready');
  assert.equal(wi.stages[0]!.ownerUserId, null);
});

test('single-person work creates exactly one active step', async () => {
  const { repo } = makeDb();
  const wi = await repo.createWorkItem({
    organizationId: ORG, creatorUserId: 'u_creator', workTypeId: 'wt', workTypeName: 'X',
    title: 'Quick task', outcome: 'Just do it', priority: 'low',
    steps: [step({ name: 'Do it', assignment: { mode: 'creator' } })], activeMemberIds: ACTIVE,
  });
  assert.equal(wi.stages.length, 1);
  assert.equal(wi.stages[0]!.status, 'ready');
  assert.equal(wi.stages[0]!.ownerUserId, 'u_creator');
});

// ---- templates: save, filter by type, reuse (4, 23, 24, 25) ----------------

test('a custom workflow can be saved as a template and reused for a new Work Item', async () => {
  const { repo } = makeDb();
  await repo.createWorkflowTemplate({
    organizationId: ORG, createdByUserId: 'u_creator', name: 'New Buyer Onboarding',
    description: 'Standard buyer setup', workTypeIds: ['wt_buyer'], steps: BUYER_STEPS,
  });
  // filtered by work type
  const forBuyer = await repo.listWorkflowTemplates(ORG, { workTypeId: 'wt_buyer' });
  assert.equal(forBuyer.length, 1);
  assert.equal(forBuyer[0]!.stepCount, 4);
  const forVendor = await repo.listWorkflowTemplates(ORG, { workTypeId: 'wt_vendor' });
  assert.equal(forVendor.length, 0, 'templates are filtered by Work Type');

  // reuse: build a Work Item from the saved template's steps
  const tmpl = await repo.getWorkflowTemplate(ORG, forBuyer[0]!.id);
  assert.ok(tmpl);
  const wi = await repo.createWorkItem({
    organizationId: ORG, creatorUserId: 'u_creator', workTypeId: 'wt_buyer', workTypeName: 'Buyer',
    title: 'Onboard XYZ', outcome: 'setup', priority: 'normal',
    relatedRecord: { type: 'buyer', id: 'b1', label: 'XYZ' },
    steps: tmpl!.steps.map((s) => ({ name: s.name, instruction: s.instruction, assignment: s.assignment, completionConfirmation: s.completionConfirmation, completionNote: s.completionNote, notifyActive: s.notifyActive, notifyComplete: s.notifyComplete })),
    templateId: tmpl!.id, templateName: tmpl!.name,
    responsibilityOwners: { CALLGRID_SETUP: 'u_setup' }, activeMemberIds: ACTIVE,
  });
  assert.equal(wi.stages.length, 4);
  assert.equal(wi.stages[1]!.name, 'Prepare Agreements');
});

test('template reuse does not copy one-time record data', async () => {
  const { repo } = makeDb();
  await repo.createWorkflowTemplate({ organizationId: ORG, createdByUserId: 'u_creator', name: 'T', workTypeIds: ['wt_buyer'], steps: BUYER_STEPS });
  const tmpl = (await repo.listWorkflowTemplates(ORG, { workTypeId: 'wt_buyer' }))[0]!;
  const full = await repo.getWorkflowTemplate(ORG, tmpl.id);
  // A template is pure step definitions — no related record, no work-item notes.
  assert.ok(!('relatedRecord' in (full as any)));
  assert.ok(full!.steps.every((s) => typeof s.name === 'string' && 'assignment' in s));
});

test('deactivating a template hides it from selection but keeps it', async () => {
  const { repo } = makeDb();
  const bp = await repo.createWorkflowTemplate({ organizationId: ORG, createdByUserId: 'u1', name: 'T', workTypeIds: ['wt_buyer'], steps: BUYER_STEPS });
  await repo.setWorkflowTemplateActive(ORG, bp.id, false);
  assert.equal((await repo.listWorkflowTemplates(ORG, { workTypeId: 'wt_buyer' })).length, 0);
  assert.equal((await repo.listWorkflowTemplates(ORG, { workTypeId: 'wt_buyer', includeInactive: true })).length, 1);
});
