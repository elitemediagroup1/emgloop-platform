// Business Process Engine · PR B (Sprint 27D) — deterministic runtime harness.
//
// Runs with the built-in Node test runner (node --import tsx --test). NO database:
// the runtime is driven against a tiny in-memory fake Prisma client (same approach
// as the other engine harnesses). Pins the two frozen constitutional decisions —
// the transition log is the sole source of truth (state is always a projection)
// and readiness is re-derived fresh before every committed transition — plus
// version pinning, immutability, append-only integrity, replay determinism, org
// isolation, and every transition kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BusinessProcessRepository, type ReadinessPort } from '../src/process-engine/business-process.repository';
import { ProcessRegistry } from '../src/process-engine/business-process.registry';
import { projectState, type TransitionLogEntry } from '../src/process-engine/business-process.projection';
import type { BusinessProcessDefinition, PhaseDefinition } from '../src/process-engine/business-process.contracts';

const NOW = new Date('2026-07-21T00:00:00Z');
const ORG = 'org_A';
const OTHER = 'org_B';

// --- readiness ports (injected; PR B never wires the real engine) -----------
const READY: ReadinessPort = () => true;
const NOT_READY: ReadinessPort = () => false;
const UNKNOWN: ReadinessPort = () => 'unknown';

// --- in-memory fake prisma --------------------------------------------------
type Row = Record<string, any>;
let seq = 0;
const nid = () => 'id_' + ++seq;
const matches = (row: Row, where: Row) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v);

function delegate(name: string, defaults: () => Row) {
  const rows: Row[] = [];
  const sort = (list: Row[], orderBy?: Row) => {
    if (!orderBy) return list;
    const [k, dir] = Object.entries(orderBy)[0]!;
    return [...list].sort((a, b) => (dir === 'desc' ? b[k] - a[k] : a[k] - b[k]));
  };
  return {
    __rows: rows,
    async create({ data }: { data: Row }) {
      // Simulate the unique (processInstanceId, sequence) constraint for the log.
      if (name === 'processTransition' && rows.some((r) => r.processInstanceId === data.processInstanceId && r.sequence === data.sequence)) {
        throw new Error('unique constraint: (processInstanceId, sequence)');
      }
      const row = { id: nid(), createdAt: NOW, updatedAt: NOW, ...defaults(), ...data };
      rows.push(row);
      return row;
    },
    async findFirst({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) {
      return sort(rows.filter((r) => matches(r, where ?? {})), orderBy)[0] ?? null;
    },
    async findMany({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) {
      return sort(rows.filter((r) => matches(r, where ?? {})), orderBy);
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}.update: not found`);
      Object.assign(row, data, { updatedAt: NOW });
      return row;
    },
    async count({ where }: { where?: Row } = {}) {
      return rows.filter((r) => matches(r, where ?? {})).length;
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
  // Interactive-transaction shim for the Registry's activate/retire flow.
  db.$transaction = async (fn: any) => fn(db);
  return db as any;
}

const PHASES: PhaseDefinition[] = [
  { key: 'p1', name: 'Contract', position: 0, ownerResponsibilityKey: 'CONTRACT_REVIEW', applicability: 'always', reopenable: true, expectedOutcomes: ['signed IO'] },
  { key: 'p2', name: 'Setup', position: 1, ownerResponsibilityKey: 'CALLGRID_SETUP', applicability: 'always', reopenable: true, expectedOutcomes: ['destination live'] },
  { key: 'p3', name: 'Activation', position: 2, ownerResponsibilityKey: 'CALLGRID_OPTIMIZATION', applicability: 'always', reopenable: false, expectedOutcomes: ['receiving calls'] },
];

async function setup(opts: { allowBackward?: boolean; allowRestart?: boolean } = {}) {
  const db = makeDb();
  const registry = new ProcessRegistry(db);
  const repo = new BusinessProcessRepository(db, registry);
  const def = await registry.createDefinition({
    organizationId: ORG, key: 'BUYER_ONBOARDING', name: 'Buyer Onboarding',
    objective: { key: 'ACQUIRE_BUYER' }, subjectType: 'destination',
    allowBackward: opts.allowBackward ?? true, allowRestart: opts.allowRestart ?? true,
    phases: PHASES,
  });
  await registry.publishDefinition(ORG, def.id);
  await registry.activateDefinition(ORG, def.id); // only an ACTIVE definition is instantiable
  const inst = await repo.createInstance({ organizationId: ORG, definitionId: def.id, subject: { type: 'destination', label: 'Acme Roofing' } });
  return { db, repo, registry, def, inst };
}

const fwd = (verified = true) => ({ kind: 'forward' as const, proposer: 'human' as const, confirmed: true, verification: { verified } });

// Advance from draft → p1 → p2 → p3 (all verified, all ready). Returns repo+inst.
async function driveToTerminal() {
  const s = await setup();
  await s.repo.applyTransition(ORG, s.inst.id, fwd(), READY); // enter p1
  await s.repo.applyTransition(ORG, s.inst.id, fwd(), READY); // p1 → p2
  await s.repo.applyTransition(ORG, s.inst.id, fwd(), READY); // p2 → p3
  return s;
}

// =====================================================================
// Projection / replay determinism / rebuild
// =====================================================================

const def = (over: Partial<BusinessProcessDefinition> = {}): BusinessProcessDefinition => ({
  key: 'BUYER_ONBOARDING', name: 'Buyer Onboarding', version: 1,
  objective: { key: 'ACQUIRE_BUYER' }, subjectType: 'destination',
  phases: PHASES, allowBackward: true, allowRestart: true, ...over,
});

test('projection rebuilds current state from the log and is deterministic', () => {
  const log: TransitionLogEntry[] = [
    { sequence: 1, kind: 'forward', fromPhaseKey: null, toPhaseKey: 'p1' },
    { sequence: 2, kind: 'forward', fromPhaseKey: 'p1', toPhaseKey: 'p2' },
  ];
  const a = projectState(def(), log);
  const b = projectState(def(), [...log].reverse()); // order-independent input
  assert.deepEqual(a, b, 'replay is deterministic regardless of input order');
  assert.equal(a.processState, 'active');
  assert.equal(a.currentPhaseKey, 'p2');
  assert.equal(a.activePhaseKey, 'p2');
  assert.deepEqual(a.completedPhaseKeys, ['p1']);
});

test('the runtime projection equals an independent replay of its own log', async () => {
  const { repo, inst } = await driveToTerminal();
  const history = await repo.getHistory(ORG, inst.id);
  const fromRepo = await repo.projectCurrentState(ORG, inst.id);
  const independent = projectState(def(), history);
  assert.equal(fromRepo.currentPhaseKey, independent.currentPhaseKey);
  assert.deepEqual(fromRepo.completedPhaseKeys, independent.completedPhaseKeys);
  assert.equal(fromRepo.processState, 'active'); // on terminal phase, not yet completed
  assert.equal(fromRepo.currentPhaseKey, 'p3');
  assert.deepEqual(fromRepo.completedPhaseKeys, ['p1', 'p2']);
});

// =====================================================================
// Version pinning & immutability
// =====================================================================

test('instances pin their definition version; a new version never mutates them', async () => {
  const { repo, registry, def: d1, inst } = await setup();
  assert.equal(inst.definitionVersion, 1);
  // Author + publish + activate a second version with a different phase shape.
  const d2 = await registry.createDefinition({
    organizationId: ORG, key: 'BUYER_ONBOARDING', name: 'Buyer Onboarding v2',
    objective: { key: 'ACQUIRE_BUYER' }, subjectType: 'destination',
    phases: [{ key: 'x', name: 'X', position: 0, ownerResponsibilityKey: 'SALES', applicability: 'always', reopenable: false }],
  });
  assert.equal(d2.version, 2);
  await registry.publishDefinition(ORG, d2.id);
  await registry.activateDefinition(ORG, d2.id); // v1 is now superseded; v2 is active
  // The running instance still projects against its PINNED v1 (its p1 exists), even
  // though v1 is now superseded — pinned instances never auto-migrate.
  await repo.applyTransition(ORG, inst.id, fwd(), READY);
  const state = await repo.projectCurrentState(ORG, inst.id);
  assert.equal(state.currentPhaseKey, 'p1'); // v1's phase, not v2's 'x'
  assert.notEqual(d1.id, d2.id);
});

test('a published definition is immutable — re-publishing is rejected', async () => {
  // setup() leaves the definition ACTIVE; only a draft can be (re)published.
  const { registry, def: d } = await setup();
  await assert.rejects(() => registry.publishDefinition(ORG, d.id), /Only a draft can be published/);
});

test('an instance cannot be created from a non-active definition', async () => {
  const db = makeDb();
  const registry = new ProcessRegistry(db);
  const repo = new BusinessProcessRepository(db, registry);
  const d = await registry.createDefinition({
    organizationId: ORG, key: 'K', name: 'K', objective: { key: 'O' }, subjectType: 'x', phases: PHASES,
  });
  // Draft (and published-but-not-activated) definitions are not instantiable.
  await assert.rejects(
    () => repo.createInstance({ organizationId: ORG, definitionId: d.id, subject: { type: 'x', label: 'y' } }),
    /non-active/,
  );
  await registry.publishDefinition(ORG, d.id);
  await assert.rejects(
    () => repo.createInstance({ organizationId: ORG, definitionId: d.id, subject: { type: 'x', label: 'y' } }),
    /non-active/,
  );
});

// =====================================================================
// Append-only guarantees & ordering
// =====================================================================

test('the transition log is append-only, contiguous, and ordered', async () => {
  const { db, repo, inst } = await driveToTerminal();
  const history = await repo.getHistory(ORG, inst.id);
  assert.deepEqual(history.map((h) => h.sequence), [1, 2, 3]);
  // A duplicate (instance, sequence) append is rejected (unique constraint).
  await assert.rejects(
    () => (db.processTransition.create as any)({ data: { organizationId: ORG, processInstanceId: inst.id, sequence: 1, kind: 'forward', proposer: 'human' } }),
    /unique constraint/,
  );
});

// =====================================================================
// applyTransition — the 7-step guarded flow
// =====================================================================

test('a legal forward advances and rebuilds the projection; emits an execution intent', async () => {
  const { repo, inst } = await setup();
  const r1 = await repo.applyTransition(ORG, inst.id, fwd(), READY);
  assert.equal(r1.applied, true);
  assert.equal(r1.state.processState, 'initiated');
  assert.equal(r1.state.currentPhaseKey, 'p1');
  assert.equal(r1.sequence, 1);
  assert.equal(r1.executionIntent?.enteredPhaseKey, 'p1');
  assert.equal(r1.executionIntent?.ownerResponsibilityKey, 'CONTRACT_REVIEW');

  const r2 = await repo.applyTransition(ORG, inst.id, fwd(), READY);
  assert.equal(r2.applied, true);
  assert.equal(r2.state.processState, 'active');
  assert.deepEqual(r2.state.completedPhaseKeys, ['p1']);
});

test('an illegal transition is rejected and nothing is appended', async () => {
  const { db, repo, inst } = await setup();
  // complete from the very first (non-terminal) position is illegal.
  const r = await repo.applyTransition(ORG, inst.id, { kind: 'complete', proposer: 'human', confirmed: true, verification: { verified: true } }, READY);
  assert.equal(r.applied, false);
  assert.ok(r.guard.denials.length > 0);
  assert.equal((db.processTransition.__rows as Row[]).length, 0, 'no transition appended');
});

test('a forward without verification cannot advance (exit not verified)', async () => {
  const { repo, inst } = await setup();
  await repo.applyTransition(ORG, inst.id, fwd(), READY); // p1 entered
  const r = await repo.applyTransition(ORG, inst.id, { kind: 'forward', proposer: 'human', confirmed: true, verification: { verified: false } }, READY);
  assert.equal(r.applied, false);
  assert.ok(r.guard.denials.some((d) => /not verified/.test(d)));
});

// =====================================================================
// Readiness is re-derived fresh (constitutional decision #2)
// =====================================================================

test('readiness is re-derived at commit — a now-unready gate rejects the forward', async () => {
  const { repo, inst } = await setup();
  await repo.applyTransition(ORG, inst.id, fwd(), READY); // p1
  // Fresh readiness now returns false → the forward is rejected on re-derivation.
  const r = await repo.applyTransition(ORG, inst.id, fwd(), NOT_READY);
  assert.equal(r.applied, false);
  assert.ok(r.guard.denials.some((d) => /not ready/.test(d)));
});

test('unknown readiness never advances', async () => {
  const { repo, inst } = await setup();
  const r = await repo.applyTransition(ORG, inst.id, fwd(), UNKNOWN);
  assert.equal(r.applied, false);
  assert.ok(r.guard.denials.some((d) => /unknown/.test(d)));
});

test('stale readiness is rejected — the proposal value differs from the fresh re-derivation', async () => {
  const { repo, inst } = await setup();
  await repo.applyTransition(ORG, inst.id, fwd(), READY); // p1
  // Proposer saw ready=true, but the fresh port now derives false → stale, reject.
  const r = await repo.applyTransition(
    ORG, inst.id,
    { kind: 'forward', proposer: 'human', confirmed: true, verification: { verified: true }, proposedReadiness: true },
    NOT_READY,
  );
  assert.equal(r.applied, false);
  assert.ok(r.guard.denials.some((d) => /changed since proposal/.test(d)));
});

// =====================================================================
// Suspend / Resume / Terminate / Complete / Regress / Reopen / Restart
// =====================================================================

test('suspend then resume moves the process on and off hold without confirmation', async () => {
  const { repo, inst } = await setup();
  await repo.applyTransition(ORG, inst.id, fwd(), READY); // active-ish (initiated)
  const held = await repo.applyTransition(ORG, inst.id, { kind: 'suspend', proposer: 'human', confirmed: false }, READY);
  assert.equal(held.applied, true);
  assert.equal(held.state.processState, 'on_hold');
  const resumed = await repo.applyTransition(ORG, inst.id, { kind: 'resume', proposer: 'human', confirmed: false }, READY);
  assert.equal(resumed.applied, true);
  assert.equal(resumed.state.processState, 'active');
});

test('regress returns to an earlier phase and resets forward progress', async () => {
  const { repo, inst } = await driveToTerminal(); // at p3
  const r = await repo.applyTransition(ORG, inst.id, { kind: 'backward', proposer: 'human', confirmed: true, toPhaseKey: 'p1' }, READY);
  assert.equal(r.applied, true);
  assert.equal(r.state.currentPhaseKey, 'p1');
  const p2 = r.state.phases.find((p) => p.phaseKey === 'p2');
  assert.equal(p2?.state, 'pending', 'downstream progress reset');
});

test('reopen re-activates a completed phase and increments its reopen count', async () => {
  const { repo, inst } = await setup();
  await repo.applyTransition(ORG, inst.id, fwd(), READY); // p1 active
  await repo.applyTransition(ORG, inst.id, fwd(), READY); // p1 exited, p2 active
  const r = await repo.applyTransition(ORG, inst.id, { kind: 'reopen', proposer: 'human', confirmed: true, toPhaseKey: 'p1' }, READY);
  assert.equal(r.applied, true);
  const p1 = r.state.phases.find((p) => p.phaseKey === 'p1');
  assert.equal(p1?.state, 'reopened');
  assert.equal(p1?.reopenedCount, 1);
  assert.equal(r.state.currentPhaseKey, 'p1');
});

test('a process completes from a verified terminal phase, then can restart afresh', async () => {
  const { repo, inst } = await driveToTerminal(); // at p3
  const done = await repo.applyTransition(ORG, inst.id, { kind: 'complete', proposer: 'human', confirmed: true, verification: { verified: true } }, READY);
  assert.equal(done.applied, true);
  assert.equal(done.state.processState, 'completed');
  assert.equal(done.state.isTerminal, true);

  const restarted = await repo.applyTransition(ORG, inst.id, { kind: 'restart', proposer: 'human', confirmed: true }, READY);
  assert.equal(restarted.applied, true);
  assert.equal(restarted.state.processState, 'draft');
  assert.equal(restarted.state.currentPhaseKey, null);
  assert.deepEqual(restarted.state.completedPhaseKeys, []);
});

test('terminate abandons the process', async () => {
  const { repo, inst } = await setup();
  await repo.applyTransition(ORG, inst.id, fwd(), READY);
  const r = await repo.applyTransition(ORG, inst.id, { kind: 'terminate', proposer: 'human', confirmed: true }, READY);
  assert.equal(r.applied, true);
  assert.equal(r.state.processState, 'abandoned');
  assert.equal(r.state.isTerminal, true);
});

// =====================================================================
// Archived processes (administrative overlay)
// =====================================================================

test('a terminal process can be archived; archival is an overlay, not a log entry', async () => {
  const { db, repo, inst } = await driveToTerminal();
  await repo.applyTransition(ORG, inst.id, { kind: 'complete', proposer: 'human', confirmed: true, verification: { verified: true } }, READY);
  const before = (db.processTransition.__rows as Row[]).length;
  await repo.archiveInstance(ORG, inst.id);
  const state = await repo.projectCurrentState(ORG, inst.id);
  assert.equal(state.archived, true);
  assert.equal(state.effectiveState, 'archived');
  assert.equal((db.processTransition.__rows as Row[]).length, before, 'archival adds no transition');
});

test('a non-terminal process cannot be archived', async () => {
  const { repo, inst } = await setup();
  await repo.applyTransition(ORG, inst.id, fwd(), READY);
  await assert.rejects(() => repo.archiveInstance(ORG, inst.id), /terminal/);
});

// =====================================================================
// Organization isolation
// =====================================================================

test('cross-organization reads and mutations fail closed (not-found)', async () => {
  const { repo, registry, inst, def: d } = await setup();
  assert.equal(await repo.loadInstance(OTHER, inst.id), null);
  assert.equal(await registry.getDefinitionById(OTHER, d.id), null);
  await assert.rejects(() => repo.projectCurrentState(OTHER, inst.id));
  await assert.rejects(() => repo.applyTransition(OTHER, inst.id, fwd(), READY));
});
