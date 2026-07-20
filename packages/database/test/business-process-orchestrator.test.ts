// Business Process Engine · PR C (Sprint 27E) — deterministic orchestration harness.
//
// Runs with the built-in Node test runner (node --import tsx --test). NO database:
// the orchestrator is driven against the same tiny in-memory fake Prisma client used
// by the PR B runtime harness, with fake boundary ports substituted by injection.
//
// This proves the orchestration boundary end to end WITHOUT any real Operational
// Readiness or Verification engine: readiness/verification arrive through injected
// ports, the process runtime stays pure, and a successful transition emits an
// ExecutionIntent to a sink that creates NO work. It pins: the five coordinated steps,
// the typed error taxonomy, fail-closed defaults, Brain-proposal intake (verification
// re-derived through the port, never trusted from the proposal), organization
// isolation, and replay determinism after orchestrated transitions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BusinessProcessRepository } from '../src/process-engine/business-process.repository';
import {
  BusinessProcessOrchestrator,
  CollectingExecutionIntentSink,
  createBusinessProcessOrchestrator,
  type OperationalReadinessPort,
  type PhaseVerificationPort,
} from '../src/process-engine/business-process.orchestrator';
import { projectState } from '../src/process-engine/business-process.projection';
import type { BusinessProcessDefinition, PhaseDefinition } from '../src/process-engine/business-process.contracts';

const NOW = new Date('2026-07-21T00:00:00Z');
const ORG = 'org_A';
const OTHER = 'org_B';

// --- fake boundary ports (injected — no real engine exists) ------------------
const READY: OperationalReadinessPort = { evaluateEntryReadiness: () => true };
const NOT_READY: OperationalReadinessPort = { evaluateEntryReadiness: () => false };
const UNKNOWN: OperationalReadinessPort = { evaluateEntryReadiness: () => 'unknown' };
const VERIFIED: PhaseVerificationPort = { verifyPhaseExit: () => ({ verified: true }) };
const NOT_VERIFIED: PhaseVerificationPort = { verifyPhaseExit: () => ({ verified: false }) };

// --- in-memory fake prisma (identical approach to the PR B harness) ----------
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
  return {
    processDefinition: delegate('processDefinition', () => ({
      status: 'draft', allowBackward: false, allowRestart: false, phases: [], metadata: {},
      publishedAt: null, objectiveLabel: null, createdByUserId: null,
    })),
    processInstance: delegate('processInstance', () => ({
      metadata: {}, archivedAt: null, subjectExternalId: null, objectiveLabel: null, createdByUserId: null,
    })),
    processTransition: delegate('processTransition', () => ({
      fromPhaseKey: null, toPhaseKey: null, proposedByUserId: null, confirmedByUserId: null,
      readinessSnapshot: {}, verificationSnapshot: {}, rationale: null, occurredAt: NOW,
    })),
  } as any;
}

const PHASES: PhaseDefinition[] = [
  { key: 'p1', name: 'Contract', position: 0, ownerResponsibilityKey: 'CONTRACT_REVIEW', applicability: 'always', reopenable: true, expectedOutcomes: ['signed IO'] },
  { key: 'p2', name: 'Setup', position: 1, ownerResponsibilityKey: 'CALLGRID_SETUP', applicability: 'always', reopenable: true, expectedOutcomes: ['destination live'] },
  { key: 'p3', name: 'Activation', position: 2, ownerResponsibilityKey: 'CALLGRID_OPTIMIZATION', applicability: 'always', reopenable: false, expectedOutcomes: ['receiving calls'] },
];

interface Ports { readiness?: OperationalReadinessPort; verification?: PhaseVerificationPort; intentSink?: CollectingExecutionIntentSink }

async function setup(ports: Ports = {}, opts: { allowBackward?: boolean; allowRestart?: boolean } = {}) {
  const db = makeDb();
  const repo = new BusinessProcessRepository(db);
  const def = await repo.createDefinition({
    organizationId: ORG, key: 'BUYER_ONBOARDING', name: 'Buyer Onboarding',
    objective: { key: 'ACQUIRE_BUYER' }, subjectType: 'destination',
    allowBackward: opts.allowBackward ?? true, allowRestart: opts.allowRestart ?? true,
    phases: PHASES,
  });
  await repo.publishDefinition(ORG, def.id);
  const inst = await repo.createInstance({ organizationId: ORG, definitionId: def.id, subject: { type: 'destination', label: 'Acme Roofing' } });
  const orchestrator = new BusinessProcessOrchestrator({ repository: repo, ...ports });
  return { db, repo, def, inst, orchestrator };
}

// A confirmed forward request through the orchestrator (facts come from the ports).
const fwdReq = (organizationId: string, instanceId: string) => ({
  organizationId, instanceId, kind: 'forward' as const, proposer: 'human' as const, confirmed: true,
});

const def = (over: Partial<BusinessProcessDefinition> = {}): BusinessProcessDefinition => ({
  key: 'BUYER_ONBOARDING', name: 'Buyer Onboarding', version: 1,
  objective: { key: 'ACQUIRE_BUYER' }, subjectType: 'destination',
  phases: PHASES, allowBackward: true, allowRestart: true, ...over,
});

// =====================================================================
// Happy path — the five coordinated steps
// =====================================================================

test('a ready + verified forward is coordinated: advances, emits an execution intent to the sink', async () => {
  const intentSink = new CollectingExecutionIntentSink();
  const { orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED, intentSink });

  // Initial entry (draft → p1): no exit to verify, readiness gates entry.
  const r1 = await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  assert.equal(r1.ok, true);
  assert.equal(r1.applied, true);
  if (!r1.ok) return;
  assert.equal(r1.state.currentPhaseKey, 'p1');
  assert.equal(r1.state.processState, 'initiated');
  assert.equal(r1.executionIntent?.enteredPhaseKey, 'p1');
  assert.equal(r1.executionIntent?.ownerResponsibilityKey, 'CONTRACT_REVIEW');
  assert.equal(r1.intentEmitted, true);
  assert.equal(intentSink.collected.length, 1, 'the sink received exactly one intent');
  assert.equal(intentSink.collected[0]!.context.organizationId, ORG);

  // p1 → p2: now the port is asked to verify p1's exit.
  const r2 = await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.deepEqual(r2.state.completedPhaseKeys, ['p1']);
  assert.equal(intentSink.collected.length, 2);
  assert.equal(intentSink.collected[1]!.intent.enteredPhaseKey, 'p2');
});

test('the sink receives NO intent when a transition is rejected (nothing to describe)', async () => {
  const intentSink = new CollectingExecutionIntentSink();
  const { orchestrator, inst } = await setup({ readiness: NOT_READY, verification: VERIFIED, intentSink });
  const r = await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  assert.equal(r.ok, false);
  assert.equal(intentSink.collected.length, 0);
});

// =====================================================================
// Typed error taxonomy
// =====================================================================

test('NOT_READY — the readiness port refuses entry', async () => {
  const { orchestrator, inst } = await setup({ readiness: NOT_READY, verification: VERIFIED });
  const r = await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'NOT_READY');
});

test('VERIFICATION_FAILED — the verification port refuses the current phase exit', async () => {
  const { orchestrator, inst } = await setup({ readiness: READY, verification: NOT_VERIFIED });
  await orchestrator.requestTransition(fwdReq(ORG, inst.id)); // enter p1 (no exit verify on entry)
  const r = await orchestrator.requestTransition(fwdReq(ORG, inst.id)); // p1 → p2 needs p1 verified
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'VERIFICATION_FAILED');
});

test('CONFIRMATION_MISSING — a business-changing kind without confirmation', async () => {
  const { orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED });
  const r = await orchestrator.requestTransition({ organizationId: ORG, instanceId: inst.id, kind: 'forward', proposer: 'human', confirmed: false });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'CONFIRMATION_MISSING');
});

test('ILLEGAL_TRANSITION — complete from a non-terminal position', async () => {
  const { orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED });
  const r = await orchestrator.requestTransition({ organizationId: ORG, instanceId: inst.id, kind: 'complete', proposer: 'human', confirmed: true });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'ILLEGAL_TRANSITION');
});

test('DEFINITION_VERSION_MISMATCH — a proposal authored for a different pinned version', async () => {
  const { orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED });
  const r = await orchestrator.requestTransition({ ...fwdReq(ORG, inst.id), expectedDefinitionVersion: 99 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'DEFINITION_VERSION_MISMATCH');
});

// =====================================================================
// Readiness changes before confirmation (staleness — constitutional decision #2)
// =====================================================================

test('readiness changes before confirmation — the proposal observed ready, the fresh port now refuses', async () => {
  const { orchestrator, inst } = await setup({ readiness: NOT_READY, verification: VERIFIED });
  // The proposer observed readiness=true; the fresh port re-derives false at commit.
  const r = await orchestrator.requestTransition({ ...fwdReq(ORG, inst.id), observedReadiness: true });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'NOT_READY');
  assert.ok(r.denials.some((d) => /changed since proposal|not ready/.test(d)));
});

// =====================================================================
// Fail-closed defaults (no real engine injected)
// =====================================================================

test('fail-closed by default — an orchestrator with only a repository refuses to advance', async () => {
  // No ports injected → readiness defaults to unknown, verification to not-verified.
  const { orchestrator, inst } = await setup();
  const r = await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'NOT_READY'); // unknown readiness never advances
});

test('the factory wires fail-closed defaults just like the constructor', async () => {
  const db = makeDb();
  const repo = new BusinessProcessRepository(db);
  const d = await repo.createDefinition({ organizationId: ORG, key: 'K', name: 'K', objective: { key: 'O' }, subjectType: 'x', phases: PHASES });
  await repo.publishDefinition(ORG, d.id);
  const inst = await repo.createInstance({ organizationId: ORG, definitionId: d.id, subject: { type: 'x', label: 'y' } });
  const orchestrator = createBusinessProcessOrchestrator(repo);
  const r = await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  assert.equal(r.ok, false);
});

// =====================================================================
// Executive Brain proposal intake (no reasoning, no bypass, no trusted verdict)
// =====================================================================

test('a Brain proposal is coordinated through the same path; verification is re-derived, not trusted', async () => {
  // The Brain asserts verification=true in its proposal, but the port says NOT verified.
  // The orchestrator must IGNORE the proposal's verdict and refuse on the port's answer.
  const { orchestrator, inst } = await setup({ readiness: READY, verification: NOT_VERIFIED });
  await orchestrator.submitProposal(ORG, inst.id, { kind: 'forward', proposer: 'brain', confirmed: true, verification: { verified: true } }); // enter p1
  const r = await orchestrator.submitProposal(ORG, inst.id, {
    kind: 'forward', proposer: 'brain', confirmed: true,
    verification: { verified: true }, // a self-asserted verdict — must be dropped
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'VERIFICATION_FAILED', 'the port verdict wins, not the proposal');
});

test('a Brain proposal cannot bypass confirmation for a business-changing kind', async () => {
  const { orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED });
  const r = await orchestrator.submitProposal(ORG, inst.id, { kind: 'forward', proposer: 'brain', confirmed: false });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'CONFIRMATION_MISSING');
});

test('a confirmed Brain proposal with ready+verified ports advances and updates the projection', async () => {
  const intentSink = new CollectingExecutionIntentSink();
  const { orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED, intentSink });
  const r = await orchestrator.submitProposal(ORG, inst.id, { kind: 'forward', proposer: 'brain', confirmed: true, rationale: 'next-best-action' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.state.currentPhaseKey, 'p1');
  assert.equal(intentSink.collected.length, 1);
});

// =====================================================================
// Projection retrieval + replay determinism after orchestrated transitions
// =====================================================================

test('projection after a transition equals an independent replay of the log', async () => {
  const { repo, orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED });
  await orchestrator.requestTransition(fwdReq(ORG, inst.id)); // p1
  await orchestrator.requestTransition(fwdReq(ORG, inst.id)); // p2

  const viaOrchestrator = await orchestrator.projectionOf(ORG, inst.id);
  const history = await repo.getHistory(ORG, inst.id);
  const independent = projectState(def(), history);
  assert.ok(viaOrchestrator);
  assert.equal(viaOrchestrator!.currentPhaseKey, independent.currentPhaseKey);
  assert.deepEqual(viaOrchestrator!.completedPhaseKeys, independent.completedPhaseKeys);
  assert.equal(viaOrchestrator!.currentPhaseKey, 'p2');
  assert.deepEqual(viaOrchestrator!.completedPhaseKeys, ['p1']);
});

test('replay after integration is deterministic and order-independent', async () => {
  const { repo, orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED });
  await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  await orchestrator.requestTransition(fwdReq(ORG, inst.id));
  const history = await repo.getHistory(ORG, inst.id);
  const a = projectState(def(), history);
  const b = projectState(def(), [...history].reverse());
  assert.deepEqual(a, b, 'the orchestrated log replays identically regardless of input order');
  assert.equal(a.currentPhaseKey, 'p3');
});

// =====================================================================
// Organization isolation
// =====================================================================

test('ORGANIZATION_MISMATCH — a cross-org instance is not-found, leaks nothing, and never throws', async () => {
  const { orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED });
  const r = await orchestrator.requestTransition(fwdReq(OTHER, inst.id));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'ORGANIZATION_MISMATCH');
  assert.equal(r.state, null, 'no projection is returned for another tenant');
  // And no transition was ever appended under either org.
  assert.equal(await orchestrator.projectionOf(OTHER, inst.id), null);
});

test('a cross-org proposal cannot advance another tenant\'s process', async () => {
  const intentSink = new CollectingExecutionIntentSink();
  const { orchestrator, inst } = await setup({ readiness: READY, verification: VERIFIED, intentSink });
  const r = await orchestrator.submitProposal(OTHER, inst.id, { kind: 'forward', proposer: 'human', confirmed: true });
  assert.equal(r.ok, false);
  assert.equal(intentSink.collected.length, 0, 'no intent emitted for a cross-org write');
  // The real (ORG) instance is still at draft — untouched by the cross-org attempt.
  const state = await orchestrator.projectionOf(ORG, inst.id);
  assert.equal(state!.processState, 'draft');
});
