// Process Registry (Sprint 27F) — deterministic definition-lifecycle harness.
//
// Runs with the built-in Node test runner (node --import tsx --test). NO database:
// the Registry is driven against the same in-memory fake Prisma client used by the
// runtime harnesses (extended with an interactive-$transaction shim for activation).
//
// Pins the five-state lifecycle draft → published → active → superseded → retired,
// its legal/illegal transitions, monotonic versioning, validation, the at-most-one-
// active invariant, organization-availability (only active is instantiable), org
// isolation, and — via the runtime — that a pinned instance keeps running after its
// definition is superseded and then retired (instances never auto-migrate).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProcessRegistry,
  toDefinitionContract,
  DEFINITION_STATUSES,
} from '../src/process-engine/business-process.registry';
import { BusinessProcessRepository, type ReadinessPort } from '../src/process-engine/business-process.repository';
import type { PhaseDefinition } from '../src/process-engine/business-process.contracts';

const NOW = new Date('2026-07-22T00:00:00Z');
const ORG = 'org_A';
const OTHER = 'org_B';
const READY: ReadinessPort = () => true;

// --- in-memory fake prisma (array-orderBy aware; interactive $transaction) ----
type Row = Record<string, any>;
let seq = 0;
const nid = () => 'id_' + ++seq;
const matches = (row: Row, where: Row) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
const applyOrder = (list: Row[], orderBy?: Row | Row[]) => {
  if (!orderBy) return list;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...list].sort((a, b) => {
    for (const clause of clauses) {
      const [k, dir] = Object.entries(clause)[0]!;
      if (a[k] < b[k]) return dir === 'desc' ? 1 : -1;
      if (a[k] > b[k]) return dir === 'desc' ? -1 : 1;
    }
    return 0;
  });
};

function delegate(name: string, defaults: () => Row) {
  const rows: Row[] = [];
  return {
    __rows: rows,
    async create({ data }: { data: Row }) {
      if (name === 'processTransition' && rows.some((r) => r.processInstanceId === data.processInstanceId && r.sequence === data.sequence)) {
        throw new Error('unique constraint: (processInstanceId, sequence)');
      }
      const row = { id: nid(), createdAt: NOW, updatedAt: NOW, ...defaults(), ...data };
      rows.push(row);
      return row;
    },
    async findFirst({ where, orderBy }: { where?: Row; orderBy?: Row | Row[] } = {}) {
      return applyOrder(rows.filter((r) => matches(r, where ?? {})), orderBy)[0] ?? null;
    },
    async findMany({ where, orderBy }: { where?: Row; orderBy?: Row | Row[] } = {}) {
      return applyOrder(rows.filter((r) => matches(r, where ?? {})), orderBy);
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}.update: not found`);
      Object.assign(row, data, { updatedAt: NOW });
      return row;
    },
  };
}

function makeDb() {
  const db: any = {
    processDefinition: delegate('processDefinition', () => ({
      status: 'draft', allowBackward: false, allowRestart: false, phases: [], metadata: {},
      publishedAt: null, activatedAt: null, supersededAt: null, retiredAt: null,
      objectiveLabel: null, createdByUserId: null,
    })),
    processInstance: delegate('processInstance', () => ({
      metadata: {}, archivedAt: null, subjectExternalId: null, objectiveLabel: null, createdByUserId: null,
    })),
    processTransition: delegate('processTransition', () => ({
      fromPhaseKey: null, toPhaseKey: null, proposedByUserId: null, confirmedByUserId: null,
      readinessSnapshot: {}, verificationSnapshot: {}, rationale: null, occurredAt: NOW,
    })),
  };
  db.$transaction = async (fn: any) => fn(db);
  return db as any;
}

const PHASES: PhaseDefinition[] = [
  { key: 'p1', name: 'Contract', position: 0, ownerResponsibilityKey: 'CONTRACT_REVIEW', applicability: 'always', reopenable: true, expectedOutcomes: ['signed IO'] },
  { key: 'p2', name: 'Setup', position: 1, ownerResponsibilityKey: 'CALLGRID_SETUP', applicability: 'always', reopenable: true, expectedOutcomes: ['destination live'] },
];

const draft = (registry: ProcessRegistry, over: Partial<Parameters<ProcessRegistry['createDefinition']>[0]> = {}) =>
  registry.createDefinition({
    organizationId: ORG, key: 'BUYER_ONBOARDING', name: 'Buyer Onboarding',
    objective: { key: 'ACQUIRE_BUYER' }, subjectType: 'destination', phases: PHASES, ...over,
  });

function reg() {
  const db = makeDb();
  return { db, registry: new ProcessRegistry(db) };
}

// =====================================================================
// Authoring & versioning
// =====================================================================

test('createDefinition mints a draft at version 1; the next same-key create is version 2', async () => {
  const { registry } = reg();
  const v1 = await draft(registry);
  assert.equal(v1.status, 'draft');
  assert.equal(v1.version, 1);
  const v2 = await draft(registry, { name: 'Buyer Onboarding v2' });
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'draft');
});

// =====================================================================
// Validation
// =====================================================================

test('validation rejects a malformed definition document', async () => {
  const { registry } = reg();
  await assert.rejects(() => draft(registry, { phases: [] }), /at least one phase/);
  await assert.rejects(() => draft(registry, { name: '' }), /requires a name/);
  await assert.rejects(() => draft(registry, { objective: { key: '' } }), /objective key/);
  await assert.rejects(
    () => draft(registry, { phases: [{ key: 'a', name: 'A', position: 0, ownerResponsibilityKey: 'X', applicability: 'always', reopenable: false }, { key: 'a', name: 'A2', position: 1, ownerResponsibilityKey: 'Y', applicability: 'always', reopenable: false }] }),
    /Duplicate phase key/,
  );
  await assert.rejects(
    () => draft(registry, { phases: [{ key: 'a', name: 'A', position: 0, ownerResponsibilityKey: 'X', applicability: 'always', reopenable: false }, { key: 'b', name: 'B', position: 0, ownerResponsibilityKey: 'Y', applicability: 'always', reopenable: false }] }),
    /Duplicate phase position/,
  );
  await assert.rejects(
    () => draft(registry, { phases: [{ key: 'a', name: 'A', position: 0, ownerResponsibilityKey: '', applicability: 'always', reopenable: false }] }),
    /owner responsibility key/,
  );
});

// =====================================================================
// Lifecycle transitions
// =====================================================================

test('publish freezes a draft; only a draft may be published', async () => {
  const { registry } = reg();
  const d = await draft(registry);
  const published = await registry.publishDefinition(ORG, d.id);
  assert.equal(published.status, 'published');
  assert.ok(published.publishedAt);
  // Re-publishing a published (or later) definition is rejected.
  await assert.rejects(() => registry.publishDefinition(ORG, d.id), /Only a draft can be published/);
});

test('activate promotes a published version and supersedes the previously active one', async () => {
  const { registry } = reg();
  const v1 = await draft(registry);
  await registry.publishDefinition(ORG, v1.id);
  const activeV1 = await registry.activateDefinition(ORG, v1.id);
  assert.equal(activeV1.status, 'active');
  assert.ok(activeV1.activatedAt);

  const v2 = await draft(registry, { name: 'v2' });
  await registry.publishDefinition(ORG, v2.id);
  const activeV2 = await registry.activateDefinition(ORG, v2.id);
  assert.equal(activeV2.status, 'active');

  // v1 is now superseded — exactly one active version remains for the key.
  const v1After = await registry.getDefinitionById(ORG, v1.id);
  assert.equal(v1After?.status, 'superseded');
  assert.ok(v1After?.supersededAt);
  const active = await registry.getActiveDefinition(ORG, 'BUYER_ONBOARDING');
  assert.equal(active?.id, v2.id);
  const allActive = await registry.listDefinitions(ORG, { key: 'BUYER_ONBOARDING', status: 'active' });
  assert.equal(allActive.length, 1, 'at most one active version per (org, key)');
});

test('activation is legal only from published', async () => {
  const { registry } = reg();
  const d = await draft(registry);
  await assert.rejects(() => registry.activateDefinition(ORG, d.id), /Only a published definition can be activated/);
  await registry.publishDefinition(ORG, d.id);
  await registry.activateDefinition(ORG, d.id);
  await assert.rejects(() => registry.activateDefinition(ORG, d.id), /already active/);
});

test('retire withdraws a version; a draft cannot be retired and retirement is idempotent-safe', async () => {
  const { registry } = reg();
  const d = await draft(registry);
  await assert.rejects(() => registry.retireDefinition(ORG, d.id), /draft cannot be retired/);
  await registry.publishDefinition(ORG, d.id);
  await registry.activateDefinition(ORG, d.id);
  const retired = await registry.retireDefinition(ORG, d.id);
  assert.equal(retired.status, 'retired');
  assert.ok(retired.retiredAt);
  await assert.rejects(() => registry.retireDefinition(ORG, d.id), /already retired/);
  // A retired version can never be resurrected to active.
  await assert.rejects(() => registry.activateDefinition(ORG, d.id), /Only a published definition can be activated/);
});

// =====================================================================
// Organization availability (instantiability)
// =====================================================================

test('resolveForInstantiation returns the row ONLY when active', async () => {
  const { registry } = reg();
  const d = await draft(registry);
  assert.equal(await registry.resolveForInstantiation(ORG, d.id), null, 'draft not instantiable');
  await registry.publishDefinition(ORG, d.id);
  assert.equal(await registry.resolveForInstantiation(ORG, d.id), null, 'published-but-not-active not instantiable');
  await registry.activateDefinition(ORG, d.id);
  assert.ok(await registry.resolveForInstantiation(ORG, d.id), 'active is instantiable');
  await registry.retireDefinition(ORG, d.id);
  assert.equal(await registry.resolveForInstantiation(ORG, d.id), null, 'retired not instantiable');
});

// =====================================================================
// Discovery
// =====================================================================

test('discovery: by id, by (key, version), active-for-key, and filtered listing', async () => {
  const { registry } = reg();
  const v1 = await draft(registry);
  await registry.publishDefinition(ORG, v1.id);
  await registry.activateDefinition(ORG, v1.id);
  const v2 = await draft(registry, { name: 'v2' });

  assert.equal((await registry.getDefinitionById(ORG, v1.id))?.id, v1.id);
  assert.equal((await registry.getDefinition(ORG, 'BUYER_ONBOARDING', 2))?.id, v2.id);
  assert.equal((await registry.getActiveDefinition(ORG, 'BUYER_ONBOARDING'))?.id, v1.id);

  const all = await registry.listDefinitions(ORG, { key: 'BUYER_ONBOARDING' });
  assert.deepEqual(all.map((d) => d.version), [2, 1], 'listed newest version first');
  const drafts = await registry.listDefinitions(ORG, { status: 'draft' });
  assert.deepEqual(drafts.map((d) => d.id), [v2.id]);

  const contract = await registry.getActiveDefinitionContract(ORG, 'BUYER_ONBOARDING');
  assert.equal(contract?.version, 1);
  assert.equal(contract?.phases.length, 2);
});

// =====================================================================
// Runtime integration — pinned instances survive supersede + retire
// =====================================================================

test('a pinned instance keeps running after its definition is superseded and then retired', async () => {
  const { db, registry } = reg();
  const repo = new BusinessProcessRepository(db, registry);

  const v1 = await draft(registry, { allowBackward: true, allowRestart: true });
  await registry.publishDefinition(ORG, v1.id);
  await registry.activateDefinition(ORG, v1.id);
  const inst = await repo.createInstance({ organizationId: ORG, definitionId: v1.id, subject: { type: 'destination', label: 'Acme' } });
  // Enter p1.
  const enter = await repo.applyTransition(ORG, inst.id, { kind: 'forward', proposer: 'human', confirmed: true, verification: { verified: true } }, READY);
  assert.equal(enter.applied, true);
  assert.equal(enter.state.currentPhaseKey, 'p1');

  // Supersede v1 by activating v2.
  const v2 = await draft(registry, { name: 'v2' });
  await registry.publishDefinition(ORG, v2.id);
  await registry.activateDefinition(ORG, v2.id);
  assert.equal((await registry.getDefinitionById(ORG, v1.id))?.status, 'superseded');

  // The pinned instance still projects and can still advance against v1.
  const afterSupersede = await repo.projectCurrentState(ORG, inst.id);
  assert.equal(afterSupersede.currentPhaseKey, 'p1');
  const advance = await repo.applyTransition(ORG, inst.id, { kind: 'forward', proposer: 'human', confirmed: true, verification: { verified: true } }, READY);
  assert.equal(advance.applied, true, 'a superseded definition still runs its existing instances');
  assert.deepEqual(advance.state.completedPhaseKeys, ['p1']);

  // Retire v1 outright — the pinned instance is still projectable (history intact).
  await registry.retireDefinition(ORG, v1.id);
  const afterRetire = await repo.projectCurrentState(ORG, inst.id);
  assert.equal(afterRetire.currentPhaseKey, 'p2');
});

// =====================================================================
// Organization isolation
// =====================================================================

test('every Registry operation is organization-scoped and fails closed cross-org', async () => {
  const { registry } = reg();
  const d = await draft(registry);
  await registry.publishDefinition(ORG, d.id);

  // Reads: cross-org is not-found (no leak).
  assert.equal(await registry.getDefinitionById(OTHER, d.id), null);
  assert.equal(await registry.getDefinition(OTHER, 'BUYER_ONBOARDING', 1), null);
  assert.equal(await registry.getActiveDefinition(OTHER, 'BUYER_ONBOARDING'), null);
  assert.deepEqual(await registry.listDefinitions(OTHER), []);
  assert.equal(await registry.resolveForInstantiation(OTHER, d.id), null);

  // Mutations: cross-org resolves to not-found and throws (never touches the row).
  await assert.rejects(() => registry.publishDefinition(OTHER, d.id));
  await assert.rejects(() => registry.activateDefinition(OTHER, d.id));
  await assert.rejects(() => registry.retireDefinition(OTHER, d.id));
  // The real row is untouched by the cross-org attempts.
  assert.equal((await registry.getDefinitionById(ORG, d.id))?.status, 'published');
});

// =====================================================================
// Contract completeness
// =====================================================================

test('the lifecycle vocabulary and contract mapper are stable', () => {
  assert.deepEqual([...DEFINITION_STATUSES], ['draft', 'published', 'active', 'superseded', 'retired']);
  const contract = toDefinitionContract({
    key: 'K', name: 'N', version: 3, objectiveKey: 'O', objectiveLabel: 'label',
    subjectType: 'destination', phases: PHASES as unknown as object, allowBackward: true, allowRestart: false,
  } as any);
  assert.equal(contract.version, 3);
  assert.equal(contract.objective.label, 'label');
  assert.equal(contract.allowBackward, true);
  assert.equal(contract.phases.length, 2);
});
