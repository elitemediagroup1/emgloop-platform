// The Work OS extension the Creator Hub added (2026-09-22), at the repository level.
//
// The same bespoke in-memory Prisma double as workflow-engine.test.ts (a few tables, an
// interactive $transaction, `include: stages`), extended only with what the extension
// touches: work_instructions, work_comments.visibility, the two return dates on
// work_instances, and org-scoped findFirst/findMany. It drives the REAL WorkRepository.
// No infra.
//
// WHAT IT PROVES.
//   - `appendSteps` on completeWorkStep continues the SAME work item: the appended steps land
//     after the last position, the first of them becomes current when the completed step was
//     last, and nothing already recorded is touched. Without it, behaviour is unchanged.
//   - Instruction sets sequence per work item and are refused across an organization.
//   - An instruction set is answered ONCE; a second answer is refused, not overwritten.
//   - The expected return is set within the organization, with who and when.
//   - A comment is internal unless it is written for the creator.
//   - A set of work items is read within one organization only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { WorkRepository } from '../src/repositories/work.repository';
import type { WorkflowStepDef } from '../src/work-os/workflow';

type Row = Record<string, any>;

function eq(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      return false;
    }
    return row[k] === v;
  });
}

function pick(row: Row, select?: Row): Row {
  if (!select) return row;
  return Object.fromEntries(Object.entries(select).filter(([, want]) => want).map(([k]) => [k, row[k]]));
}

function sorted(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [field, dir] = Object.entries(orderBy)[0] as [string, 'asc' | 'desc'];
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * sign);
}

function p2002(fields: string): never {
  const e = new Error(`Unique constraint failed on the fields: (${fields})`) as Error & { code: string };
  e.code = 'P2002';
  throw e;
}

function makeDb(onWorkCompleted?: ConstructorParameters<typeof WorkRepository>[1]) {
  const t = {
    workInstance: [] as Row[], workStage: [] as Row[], workNotification: [] as Row[], workAssignment: [] as Row[],
    workComment: [] as Row[], workInstruction: [] as Row[], blueprint: [] as Row[], blueprintStage: [] as Row[],
  };
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const stagesOf = (wid: string) => t.workStage.filter((s) => s.workInstanceId === wid).sort((a, b) => a.position - b.position);
  const commentsOf = (wid: string) => t.workComment.filter((c) => c.workInstanceId === wid);
  const shape = (inst: Row | undefined, include?: Row, select?: Row): Row | null => {
    if (!inst) return null;
    if (select) return pick(inst, select);
    return { ...inst, ...(include?.stages ? { stages: stagesOf(inst.id) } : {}), ...(include?.comments ? { comments: commentsOf(inst.id) } : {}) };
  };

  const prisma: any = {
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(prisma),
    workInstance: {
      create: async ({ data }: any) => {
        const r = { id: id('wi'), currentStageId: null, completedAt: null, description: null, metadata: {}, requestedReturnAt: null, expectedReturnAt: null, expectedReturnSetByUserId: null, expectedReturnSetAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        t.workInstance.push(r);
        return r;
      },
      findUnique: async ({ where, include, select }: any) => shape(t.workInstance.find((x) => x.id === where.id), include, select),
      findFirst: async ({ where, include, select }: any) => shape(t.workInstance.find((x) => eq(x, where)), include, select),
      findMany: async ({ where, include }: any) => t.workInstance.filter((x) => eq(x, where)).map((x) => shape(x, include)),
      update: async ({ where, data, include }: any) => { const r = t.workInstance.find((x) => x.id === where.id); if (!r) throw new Error('workInstance.update: row not found'); Object.assign(r, data); return shape(r, include); },
    },
    workStage: {
      create: async ({ data }: any) => { const r = { id: id('ws'), ownerUserId: null, startedAt: null, completedAt: null, completedByUserId: null, description: null, metadata: {}, createdAt: new Date(), updatedAt: new Date(), ...data }; t.workStage.push(r); return r; },
      update: async ({ where, data }: any) => { const r = t.workStage.find((x) => x.id === where.id); if (!r) throw new Error('workStage.update: row not found'); Object.assign(r, data); return r; },
    },
    workNotification: { create: async ({ data }: any) => { const r = { id: id('wn'), readAt: null, metadata: {}, createdAt: new Date(), ...data }; t.workNotification.push(r); return r; } },
    workAssignment: { create: async ({ data }: any) => { const r = { id: id('wa'), assignedAt: new Date(), unassignedAt: null, metadata: {}, ...data }; t.workAssignment.push(r); return r; } },
    workComment: {
      create: async ({ data }: any) => { const r = { id: id('wc'), workStageId: null, visibility: 'internal', createdAt: new Date(), ...data }; t.workComment.push(r); return r; },
    },
    workInstruction: {
      create: async ({ data }: any) => {
        if (t.workInstruction.some((x) => x.workInstanceId === data.workInstanceId && x.sequence === data.sequence)) p2002('workInstanceId,sequence');
        const r = { id: id('ins'), workStageId: null, originatorLabel: null, refersToVersionId: null, summary: null, notes: [], requestedReturnAt: null, answeredByVersionId: null, answeredAt: null, addressed: [], visibleToCreator: true, createdAt: new Date(), ...data };
        t.workInstruction.push(r);
        return r;
      },
      findFirst: async ({ where, orderBy, select }: any) => { const r = sorted(t.workInstruction.filter((x) => eq(x, where)), orderBy)[0]; return r ? pick(r, select) : null; },
      findMany: async ({ where, orderBy }: any) => sorted(t.workInstruction.filter((x) => eq(x, where)), orderBy),
      update: async ({ where, data }: any) => { const r = t.workInstruction.find((x) => x.id === where.id); if (!r) throw new Error('workInstruction.update: row not found'); Object.assign(r, data); return r; },
    },
    blueprint: {
      create: async ({ data }: any) => { const r = { id: id('bp'), status: 'active', description: null, metadata: {}, createdAt: new Date(), updatedAt: new Date(), ...data }; t.blueprint.push(r); return r; },
      findFirst: async ({ where }: any) => t.blueprint.find((b) => eq(b, where)) ?? null,
      findMany: async ({ where }: any) => t.blueprint.filter((b) => eq(b, where)),
    },
    blueprintStage: {
      create: async ({ data }: any) => { const r = { id: id('bs'), description: null, defaultOwnerUserId: null, requiresApproval: false, metadata: {}, createdAt: new Date(), updatedAt: new Date(), ...data }; t.blueprintStage.push(r); return r; },
    },
  };
  return { repo: new WorkRepository(prisma as unknown as PrismaClient, onWorkCompleted), t };
}

const ORG = 'org_a';
const OTHER = 'org_b';
const ACTIVE = new Set(['u_creator', 'u_editor', 'u_reviewer', 'u_owner']);
const D = new Date('2026-10-01T12:00:00.000Z');

function step(over: Partial<WorkflowStepDef>): WorkflowStepDef {
  return { name: 'Step', instruction: 'do it', assignment: { mode: 'creator' }, completionNote: 'optional', notifyActive: true, notifyComplete: false, ...over };
}

/** A production's two steps: an unowned Edit, then the creator's own review. */
const PRODUCTION_STEPS: WorkflowStepDef[] = [
  step({ name: 'Edit', assignment: { mode: 'unassigned' } }),
  step({ name: 'Creator review', assignment: { mode: 'specific', specificUserId: 'u_creator' } }),
];

async function newProduction(repo: WorkRepository, over: Partial<Parameters<WorkRepository['createWorkItem']>[0]> = {}) {
  return repo.createWorkItem({
    organizationId: ORG, creatorUserId: 'u_creator', workTypeId: 'wt_production', workTypeName: 'Creator production',
    title: 'Production 1 · Reel', outcome: 'Tighten the opening', priority: 'normal',
    steps: PRODUCTION_STEPS, activeMemberIds: ACTIVE, ...over,
  });
}

const complete = (repo: WorkRepository, wid: string, stageId: string, by: string, extra: Partial<Parameters<WorkRepository['completeWorkStep']>[0]> = {}) =>
  repo.completeWorkStep({ organizationId: ORG, workInstanceId: wid, stageId, completedByUserId: by, activeMemberIds: ACTIVE, ...extra });

// ---- completeWorkStep + appendSteps ------------------------------------------------------------

test('completing the LAST step with appendSteps continues the same work item: the appended steps land after the last position and the first of them becomes current', async () => {
  const { repo, t } = makeDb();
  let wi = await newProduction(repo);
  wi = await complete(repo, wi.id, wi.stages[0]!.id, 'u_editor');
  assert.equal(wi.stages[1]!.status, 'ready');
  assert.equal(wi.stages[1]!.ownerUserId, 'u_creator');

  wi = await complete(repo, wi.id, wi.stages[1]!.id, 'u_creator', {
    note: 'Changes requested',
    appendSteps: [
      step({ name: 'Edit · round 2', assignment: { mode: 'specific', specificUserId: 'u_editor' } }),
      step({ name: 'Creator review · round 2', assignment: { mode: 'specific', specificUserId: 'u_creator' } }),
    ],
  });

  assert.equal(wi.status, 'active', 'the work item is NOT complete: a further round follows');
  assert.equal(wi.completedAt, null);
  assert.deepEqual(wi.stages.map((s) => s.name), ['Edit', 'Creator review', 'Edit · round 2', 'Creator review · round 2']);
  assert.deepEqual(wi.stages.map((s) => s.position), [1, 2, 3, 4], 'appended after the last position');
  assert.equal(wi.stages[0]!.status, 'completed', 'nothing already recorded is touched');
  assert.equal(wi.stages[0]!.completedByUserId, 'u_editor');
  assert.equal(wi.stages[1]!.status, 'completed');
  assert.equal(wi.stages[1]!.completedByUserId, 'u_creator');
  assert.equal((wi.stages[1]!.metadata as Row).completionNoteText, 'Changes requested');
  assert.equal(wi.stages[2]!.status, 'ready', 'the first appended step is current');
  assert.equal(wi.stages[2]!.ownerUserId, 'u_editor', 'resolved by its stored mode at handoff');
  assert.ok(wi.stages[2]!.startedAt);
  assert.equal(wi.stages[3]!.status, 'pending');
  assert.equal(wi.stages[3]!.ownerUserId, null, 'later appended steps resolve when they become active');
  assert.equal(wi.currentStageId, wi.stages[2]!.id);

  assert.equal(t.workNotification.filter((n) => n.userId === 'u_editor' && n.workStageId === wi.stages[2]!.id && n.type === 'next_action_ready').length, 1, 'the next owner is told');
  assert.equal(t.workNotification.filter((n) => n.type === 'completed').length, 0, 'nobody is told the work completed');
  assert.ok(t.workAssignment.some((a) => a.userId === 'u_editor' && a.workStageId === wi.stages[2]!.id && a.assignedByUserId === 'u_creator'), 'the handoff is recorded');
});

test('appendSteps when the completed step is NOT last: the existing next step is chosen; the appended steps wait at the end', async () => {
  const { repo } = makeDb();
  let wi = await newProduction(repo);
  wi = await complete(repo, wi.id, wi.stages[0]!.id, 'u_editor', { appendSteps: [step({ name: 'Extra', assignment: { mode: 'specific', specificUserId: 'u_reviewer' } })] });
  assert.deepEqual(wi.stages.map((s) => [s.name, s.position, s.status]), [['Edit', 1, 'completed'], ['Creator review', 2, 'ready'], ['Extra', 3, 'pending']]);
  assert.equal(wi.stages[1]!.ownerUserId, 'u_creator');
  assert.equal(wi.stages[2]!.ownerUserId, null);
  assert.equal(wi.currentStageId, wi.stages[1]!.id);
});

test("an appended 'previous' step goes to whoever completed the step before it, and an appended owner who is no longer active lands unassigned", async () => {
  const { repo } = makeDb();
  let wi = await newProduction(repo);
  wi = await complete(repo, wi.id, wi.stages[0]!.id, 'u_editor');
  wi = await complete(repo, wi.id, wi.stages[1]!.id, 'u_creator', {
    appendSteps: [step({ name: 'Back to me', assignment: { mode: 'previous' } }), step({ name: 'Gone', assignment: { mode: 'specific', specificUserId: 'u_gone' } })],
  });
  assert.equal(wi.stages[2]!.ownerUserId, 'u_creator', "'previous' resolves to the completer of the step just completed");
  wi = await complete(repo, wi.id, wi.stages[2]!.id, 'u_creator');
  assert.equal(wi.stages[3]!.status, 'ready');
  assert.equal(wi.stages[3]!.ownerUserId, null, 'fail closed: a non-member never receives a step');
  assert.equal(wi.status, 'active');
});

test('without appendSteps (or with an empty list) completing the last step still completes the work item, unchanged', async () => {
  for (const extra of [{}, { appendSteps: [] as WorkflowStepDef[] }]) {
    const { repo, t } = makeDb();
    let wi = await newProduction(repo);
    wi = await complete(repo, wi.id, wi.stages[0]!.id, 'u_editor');
    wi = await complete(repo, wi.id, wi.stages[1]!.id, 'u_creator', extra);
    assert.equal(wi.status, 'completed');
    assert.ok(wi.completedAt);
    assert.equal(wi.currentStageId, null);
    assert.equal(wi.stages.length, 2, 'no step was added');
    assert.deepEqual([...new Set(t.workNotification.filter((n) => n.type === 'completed').map((n) => n.userId))].sort(), ['u_creator'], 'the participants are told the work completed');
    await assert.rejects(complete(repo, wi.id, wi.stages[1]!.id, 'u_creator'), /already complete/);
  }
});

test('the completion hook fires only when the work item actually completes, not when a round is appended', async () => {
  const fired: string[] = [];
  const { repo: hooked } = makeDb(async (_organizationId, workInstanceId) => { fired.push(workInstanceId); });
  let wi = await newProduction(hooked);
  wi = await complete(hooked, wi.id, wi.stages[0]!.id, 'u_editor');
  wi = await complete(hooked, wi.id, wi.stages[1]!.id, 'u_creator', { appendSteps: [step({ name: 'Edit · round 2', assignment: { mode: 'specific', specificUserId: 'u_editor' } })] });
  assert.deepEqual(fired, [], 'a further round is not a completion');
  wi = await complete(hooked, wi.id, wi.stages[2]!.id, 'u_editor');
  assert.equal(wi.status, 'completed');
  assert.deepEqual(fired, [wi.id]);
});

// ---- requestedReturnAt on createWorkItem ------------------------------------------------------

test("createWorkItem stores requestedReturnAt as the requester's fact and never as a commitment", async () => {
  const { repo } = makeDb();
  const asked = await newProduction(repo, { requestedReturnAt: D });
  assert.equal(asked.requestedReturnAt, D);
  assert.equal(asked.expectedReturnAt, null);
  assert.equal(asked.expectedReturnSetByUserId, null);
  const silent = await newProduction(repo);
  assert.equal(silent.requestedReturnAt, null);
});

// ---- setExpectedReturn --------------------------------------------------------------------------

test('setExpectedReturn is organization-scoped and records who set it and when; clearing it is a change too', async () => {
  const { repo } = makeDb();
  const wi = await newProduction(repo, { requestedReturnAt: D });
  const set = await repo.setExpectedReturn({ organizationId: ORG, workInstanceId: wi.id, expectedReturnAt: new Date('2026-09-29T17:00:00.000Z'), setByUserId: 'u_owner' });
  assert.ok(set);
  assert.equal(set.expectedReturnAt?.toISOString(), '2026-09-29T17:00:00.000Z');
  assert.equal(set.expectedReturnSetByUserId, 'u_owner');
  assert.ok(set.expectedReturnSetAt instanceof Date);
  assert.equal(set.requestedReturnAt, D, 'the request is untouched');

  assert.equal(await repo.setExpectedReturn({ organizationId: OTHER, workInstanceId: wi.id, expectedReturnAt: D, setByUserId: 'u_intruder' }), null, 'another organization: null, not forbidden');
  const untouched = await repo.getWorkInstance(ORG, wi.id);
  assert.equal(untouched?.expectedReturnSetByUserId, 'u_owner', 'and nothing was written');

  const cleared = await repo.setExpectedReturn({ organizationId: ORG, workInstanceId: wi.id, expectedReturnAt: null, setByUserId: 'u_editor' });
  assert.equal(cleared?.expectedReturnAt, null);
  assert.equal(cleared?.expectedReturnSetByUserId, 'u_editor', 'who withdrew the commitment is a fact');
});

// ---- instruction sets ---------------------------------------------------------------------------

test('addInstruction sequences 1, 2, 3 per work item, stores provenance and notes as given, and refuses a cross-organization work item', async () => {
  const { repo, t } = makeDb();
  const wi = await newProduction(repo);
  const other = await newProduction(repo, { title: 'Production 1 · Story' });
  const note = { id: 'n1', atSeconds: 2, kind: 'CHANGE', text: 'Kona before the logo' };
  const i1 = await repo.addInstruction({ organizationId: ORG, workInstanceId: wi.id, workStageId: wi.currentStageId, originatorKind: 'CREATOR', enteredByUserId: 'u_creator', refersToVersionId: 'v0', summary: 'Tighten', notes: [note], requestedReturnAt: D });
  const i2 = await repo.addInstruction({ organizationId: ORG, workInstanceId: wi.id, originatorKind: 'BRAND_RELAYED', originatorLabel: 'Kona Coffee', enteredByUserId: 'u_owner', notes: [] });
  const i3 = await repo.addInstruction({ organizationId: ORG, workInstanceId: wi.id, originatorKind: 'EMG', enteredByUserId: 'u_editor', notes: [], visibleToCreator: false });
  const o1 = await repo.addInstruction({ organizationId: ORG, workInstanceId: other.id, originatorKind: 'CREATOR', enteredByUserId: 'u_creator', notes: [] });
  assert.deepEqual([i1.sequence, i2.sequence, i3.sequence], [1, 2, 3]);
  assert.equal(o1.sequence, 1, 'sequences are per work item');

  assert.equal(i1.originatorKind, 'CREATOR');
  assert.equal(i1.originatorLabel, null);
  assert.equal(i1.enteredByUserId, 'u_creator');
  assert.equal(i1.refersToVersionId, 'v0');
  assert.equal(i1.summary, 'Tighten');
  assert.deepEqual(i1.notes, [note]);
  assert.equal(i1.requestedReturnAt, D);
  assert.equal(i1.workStageId, wi.currentStageId);
  assert.equal(i1.visibleToCreator, true);
  assert.equal(i1.answeredByVersionId, null);
  assert.deepEqual(i1.addressed, []);
  assert.equal(i2.originatorLabel, 'Kona Coffee', 'who said it');
  assert.equal(i2.enteredByUserId, 'u_owner', 'who entered it');
  assert.equal(i3.visibleToCreator, false);

  await assert.rejects(
    repo.addInstruction({ organizationId: OTHER, workInstanceId: wi.id, originatorKind: 'CREATOR', enteredByUserId: 'u_intruder', notes: [] }),
    /Work instance not found/,
    'another organization cannot add an instruction set',
  );
  assert.equal(t.workInstruction.filter((x) => x.workInstanceId === wi.id).length, 3, 'and nothing was written');

  assert.deepEqual((await repo.listInstructions(ORG, wi.id)).map((x) => x.id), [i1.id, i2.id, i3.id]);
  assert.deepEqual(await repo.listInstructions(OTHER, wi.id), [], 'listed within the organization only');
});

test('answerInstruction stamps the answering version once; a second answer is refused, not overwritten; another organization finds nothing', async () => {
  const { repo } = makeDb();
  const wi = await newProduction(repo);
  const i1 = await repo.addInstruction({ organizationId: ORG, workInstanceId: wi.id, originatorKind: 'CREATOR', enteredByUserId: 'u_creator', notes: [{ id: 'n1', atSeconds: 2, kind: 'CHANGE', text: 'x' }] });
  const i2 = await repo.addInstruction({ organizationId: ORG, workInstanceId: wi.id, originatorKind: 'CREATOR', enteredByUserId: 'u_creator', notes: [] });

  const answered = await repo.answerInstruction({ organizationId: ORG, instructionId: i1.id, answeredByVersionId: 'v1', addressed: [{ noteId: 'n1', addressed: true, reply: 'done' }] });
  assert.ok(answered);
  assert.equal(answered.answeredByVersionId, 'v1');
  assert.ok(answered.answeredAt instanceof Date);
  assert.deepEqual(answered.addressed, [{ noteId: 'n1', addressed: true, reply: 'done' }]);

  await assert.rejects(
    repo.answerInstruction({ organizationId: ORG, instructionId: i1.id, answeredByVersionId: 'v2', addressed: [] }),
    /already been answered/,
  );
  const still = (await repo.listInstructions(ORG, wi.id)).find((x) => x.id === i1.id);
  assert.equal(still?.answeredByVersionId, 'v1', 'the first answer stands');
  assert.deepEqual(still?.addressed, [{ noteId: 'n1', addressed: true, reply: 'done' }]);

  assert.equal(await repo.answerInstruction({ organizationId: OTHER, instructionId: i2.id, answeredByVersionId: 'v9', addressed: [] }), null, 'another organization: null');
  assert.equal((await repo.listInstructions(ORG, wi.id)).find((x) => x.id === i2.id)?.answeredByVersionId, null, 'and nothing was written');
});

// ---- comments -----------------------------------------------------------------------------------

test('addWorkComment defaults visibility to internal, keeps creator_visible when asked, and refuses a cross-organization work item', async () => {
  const { repo, t } = makeDb();
  const wi = await newProduction(repo);
  const internal = await repo.addWorkComment({ organizationId: ORG, workInstanceId: wi.id, userId: 'u_editor', body: 'Legal flagged the claim' });
  assert.equal(internal.visibility, 'internal', 'internal unless written for the creator');
  const visible = await repo.addWorkComment({ organizationId: ORG, workInstanceId: wi.id, workStageId: wi.currentStageId, userId: 'u_owner', body: 'Back Friday', visibility: 'creator_visible' });
  assert.equal(visible.visibility, 'creator_visible');
  assert.equal(visible.workStageId, wi.currentStageId);
  await assert.rejects(repo.addWorkComment({ organizationId: OTHER, workInstanceId: wi.id, userId: 'u_intruder', body: 'x' }), /Work instance not found/);
  assert.equal(t.workComment.length, 2);
  assert.deepEqual((await repo.getWorkInstance(ORG, wi.id))?.comments.map((c) => c.visibility), ['internal', 'creator_visible']);
});

// ---- getWorkInstances ---------------------------------------------------------------------------

test('getWorkInstances returns only the organization\'s work items, with stages and comments, and nothing for an empty list', async () => {
  const { repo } = makeDb();
  const mine = await newProduction(repo);
  const theirs = await newProduction(repo, { organizationId: OTHER, activeMemberIds: new Set(['u_creator']) });
  await repo.addWorkComment({ organizationId: ORG, workInstanceId: mine.id, userId: 'u_editor', body: 'note' });
  const found = await repo.getWorkInstances(ORG, [mine.id, theirs.id, 'wi_missing']);
  assert.deepEqual(found.map((i) => i.id), [mine.id], "another organization's id is simply not there");
  assert.equal(found[0]?.stages.length, 2);
  assert.equal(found[0]?.comments.length, 1);
  assert.deepEqual(await repo.getWorkInstances(ORG, []), []);
});
