// Work Intelligence Foundation (Sprint 27, PR #121A) — deterministic harness.
//
// Runs with the built-in Node test runner (node --import tsx --test). Requires
// NO database: pure policy is tested directly, and the repositories are driven
// against a small in-memory fake Prisma client (same approach as
// verified-knowledge.repository.test.ts). The decisions pinned here are the ones
// worth pinning — decisions about MEANING: unknown is not satisfied, non-required
// is not missing, readiness is derived, approvals are version-specific, handoffs
// are auditable and recipient-gated, routing never guesses, org isolation holds,
// and completion is distinct from verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveReadiness,
  isVersionApprovedAtScope,
  isCurrentVersionApproved,
  buildDedupeKey,
  canTransition,
  isPrivilegedTransition,
  resolveRoutingPreference,
} from '../src/repositories/work-intelligence.policy';
import { ResponsibilityRepository } from '../src/repositories/responsibility.repository';
import { WorkIntelligenceRepository } from '../src/repositories/work-intelligence.repository';

// =====================================================================
// PURE POLICY — no I/O
// =====================================================================

test('#1 unknown requirement does not satisfy readiness', () => {
  const r = deriveReadiness([{ key: 'io', required: true, status: 'unknown', category: 'contract' }]);
  assert.equal(r.ready, false);
});

test('#2 non-required requirement is excluded from readiness', () => {
  const r = deriveReadiness([
    { key: 'msa', required: false, status: 'missing', category: 'contract' },
    { key: 'io', required: true, status: 'signed', category: 'contract' },
  ]);
  assert.equal(r.ready, true);
  assert.equal(r.requiredCount, 1); // only the required IO counted
});

test('#3/#4 required unsigned contract blocks readiness', () => {
  const r = deriveReadiness([{ key: 'io', required: true, status: 'redlining', category: 'contract' }]);
  assert.equal(r.ready, false);
});

test('#5 missing specification blocks readiness', () => {
  const r = deriveReadiness([
    { key: 'destination_specs', required: true, status: 'partial', category: 'specification' },
  ]);
  assert.equal(r.ready, false);
});

test('#6 expired requirement evidence revokes readiness', () => {
  const past = new Date('2020-01-01T00:00:00Z');
  const r = deriveReadiness(
    [{ key: 'io', required: true, status: 'signed', category: 'contract', expiresAt: past }],
    { now: new Date('2026-07-20T00:00:00Z') },
  );
  assert.equal(r.ready, false);
});

test('#7 revoked evidence revokes readiness', () => {
  const r = deriveReadiness([{ key: 'io', required: true, status: 'revoked', category: 'contract' }]);
  assert.equal(r.ready, false);
});

test('#8/#9 internal approval is not buyer approval and vice-versa', () => {
  const approvals = [
    { workAssetVersionId: 'v1', scope: 'internal', decision: 'approved', decidedAt: new Date(1) },
  ];
  assert.equal(isVersionApprovedAtScope(approvals, 'v1', 'internal'), true);
  assert.equal(isVersionApprovedAtScope(approvals, 'v1', 'buyer'), false);
});

test('#10 only the current asset version approvals count', () => {
  const asset = { id: 'a1', currentVersion: 2 };
  const versions = [
    { id: 'v1', workAssetId: 'a1', version: 1 },
    { id: 'v2', workAssetId: 'a1', version: 2 },
  ];
  const approvals = [
    { workAssetVersionId: 'v1', scope: 'internal', decision: 'approved', decidedAt: new Date(1) },
  ];
  assert.equal(isCurrentVersionApproved(asset, versions, approvals, 'internal'), false);
});

test('#11 a new asset version inherits no approval', () => {
  const asset = { id: 'a1', currentVersion: 2 };
  const versions = [
    { id: 'v1', workAssetId: 'a1', version: 1 },
    { id: 'v2', workAssetId: 'a1', version: 2 },
  ];
  // v1 fully approved; v2 has nothing.
  const approvals = [
    { workAssetVersionId: 'v1', scope: 'internal', decision: 'approved', decidedAt: new Date(1) },
    { workAssetVersionId: 'v1', scope: 'buyer', decision: 'approved', decidedAt: new Date(2) },
  ];
  assert.equal(isCurrentVersionApproved(asset, versions, approvals, 'internal'), false);
  assert.equal(isCurrentVersionApproved(asset, versions, approvals, 'buyer'), false);
});

test('#12 an active revision request supersedes a prior approval', () => {
  const approvals = [
    { workAssetVersionId: 'v2', scope: 'buyer', decision: 'approved', decidedAt: new Date(1) },
    { workAssetVersionId: 'v2', scope: 'buyer', decision: 'revision_requested', decidedAt: new Date(2) },
  ];
  assert.equal(isVersionApprovedAtScope(approvals, 'v2', 'buyer'), false);
});

test('#24 dedupe keys are deterministic and discriminating', () => {
  const base = {
    organizationId: 'org1',
    workType: 'callgrid_optimization',
    ruleId: 'destination-rate-limited',
    subjectType: 'destination',
    subjectRef: 'dest-42',
    conditionClass: 'rate_limited',
  };
  assert.equal(buildDedupeKey(base), buildDedupeKey({ ...base }));
  assert.equal(buildDedupeKey(base), buildDedupeKey({ ...base, subjectRef: ' DEST-42 ' })); // normalized
  assert.notEqual(buildDedupeKey(base), buildDedupeKey({ ...base, subjectRef: 'dest-43' }));
});

test('lifecycle graph allows legal transitions and forbids illegal ones', () => {
  assert.equal(canTransition('open', 'in_progress'), true);
  assert.equal(canTransition('in_progress', 'completed'), true);
  assert.equal(canTransition('completed', 'verified'), true);
  assert.equal(canTransition('completed', 'in_progress'), false);
  assert.equal(canTransition('archived', 'open'), false);
  assert.equal(isPrivilegedTransition('cancelled', 'reopened'), true);
});

test('#33 routing never silently picks an arbitrary user', () => {
  const twoPrimaries = resolveRoutingPreference({
    assignments: [
      { userId: 'u1', assignmentType: 'primary', active: true },
      { userId: 'u2', assignmentType: 'primary', active: true },
    ],
  });
  assert.equal(twoPrimaries.userId, null);
  assert.equal(twoPrimaries.via, 'ambiguous');

  const explicit = resolveRoutingPreference({
    explicitOwnerUserId: 'uX',
    assignments: [{ userId: 'u1', assignmentType: 'primary', active: true }],
  });
  assert.equal(explicit.userId, 'uX');
  assert.equal(explicit.via, 'explicit');
});

test('#34 missing responsibility mapping resolves to Needs Owner', () => {
  const r = resolveRoutingPreference({ assignments: [] });
  assert.equal(r.userId, null);
  assert.equal(r.via, 'needs_owner');
});

// =====================================================================
// In-memory Prisma fake
// =====================================================================

type Row = Record<string, any>;
let seq = 0;
const nid = () => 'id_' + ++seq;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
}

// Per-delegate defaults applied on create (mirrors Prisma schema @default()).
const DEFAULTS: Record<string, () => Row> = {
  workInstance: () => ({ createdAt: new Date(), source: 'manual', status: 'open' }),
  workAsset: () => ({ currentVersion: 1, status: 'draft', createdAt: new Date() }),
  workAssetVersion: () => ({ supersededAt: null, submittedAt: new Date(), createdAt: new Date() }),
  workAssetApproval: () => ({ revokedAt: null, decidedAt: new Date(), createdAt: new Date() }),
  workHandoff: () => ({ status: 'proposed', proposedAt: new Date(), createdAt: new Date() }),
  workBlocker: () => ({ active: true, openedAt: new Date(), createdAt: new Date() }),
  workEvent: () => ({ occurredAt: new Date(), createdAt: new Date(), data: {} }),
  workRequirement: () => ({ required: true, status: 'unknown', createdAt: new Date() }),
  responsibility: () => ({ active: true, createdAt: new Date() }),
  responsibilityAssignment: () => ({ active: true, assignmentType: 'primary', assignedAt: new Date() }),
  workLink: () => ({ provenance: 'manual', createdAt: new Date() }),
};

const INCLUDE: Record<string, Record<string, (row: Row, db: Db) => Row | null>> = {
  workAssetVersion: { asset: (row, db) => db.workAsset.__rows.find((r) => r.id === row.workAssetId) ?? null },
  workAssetApproval: { asset: (row, db) => db.workAsset.__rows.find((r) => r.id === row.workAssetId) ?? null },
};

function makeDelegate(name: string, dbRef: { db?: Db }) {
  const rows: Row[] = [];
  const applyInclude = (row: Row, include?: Row): Row => {
    if (!include || !row) return row;
    const out = { ...row };
    for (const [rel, on] of Object.entries(include)) {
      const resolver = INCLUDE[name]?.[rel];
      if (on && resolver && dbRef.db) out[rel] = resolver(row, dbRef.db);
    }
    return out;
  };
  return {
    __rows: rows,
    async create({ data }: { data: Row }) {
      const row = { id: nid(), ...(DEFAULTS[name]?.() ?? {}), ...data };
      rows.push(row);
      return row;
    },
    async findUnique({ where, include }: { where: Row; include?: Row }) {
      return applyInclude(rows.find((r) => matches(r, where)) ?? null, include);
    },
    async findFirst({ where, include }: { where?: Row; include?: Row } = {}) {
      return applyInclude(rows.find((r) => matches(r, where ?? {})) ?? null, include);
    },
    async findMany({ where, include }: { where?: Row; include?: Row } = {}) {
      return rows.filter((r) => matches(r, where ?? {})).map((r) => applyInclude(r, include));
    },
    async count({ where }: { where?: Row } = {}) {
      return rows.filter((r) => matches(r, where ?? {})).length;
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}.update: not found`);
      Object.assign(row, data);
      return row;
    },
    async updateMany({ where, data }: { where?: Row; data: Row }) {
      const hit = rows.filter((r) => matches(r, where ?? {}));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
}

type Db = ReturnType<typeof makeDb>;
function makeDb() {
  const ref: { db?: Db } = {};
  const names = [
    'workInstance', 'workRequirement', 'workLink', 'workBlocker', 'workHandoff',
    'workAsset', 'workAssetVersion', 'workAssetApproval', 'workEvent',
    'responsibility', 'responsibilityAssignment', 'customer', 'conversation', 'marketplaceCall',
  ] as const;
  const db: Row = {};
  for (const n of names) db[n] = makeDelegate(n, ref);
  db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(db);
  ref.db = db as Db;
  return db as Db;
}

function setup() {
  const db = makeDb();
  const responsibilities = new ResponsibilityRepository(db as any);
  const work = new WorkIntelligenceRepository(db as any, responsibilities);
  return { db, responsibilities, work };
}

const ORG = 'org_A';
const OTHER = 'org_B';

// =====================================================================
// REPOSITORY behavior
// =====================================================================

test('#20 manual work preserves manual provenance', async () => {
  const { work } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG,
    createdByUserId: 'matt',
    title: 'Reconcile invoices',
    reason: 'Month-end close',
    ownerUserId: 'matt',
  });
  assert.equal(wi.source, 'manual');
  assert.equal(wi.status, 'open');
  assert.equal(wi.ownerUserId, 'matt');
  assert.equal(wi.workType, 'general');
});

test('routing is integrated: an unowned item routes to the responsibility holder', async () => {
  const { work, responsibilities } = setup();
  const resp = await responsibilities.ensureResponsibility({
    organizationId: ORG, key: 'CALLGRID_SETUP', name: 'CallGrid Setup',
  });
  await responsibilities.assignResponsibility({
    organizationId: ORG, responsibilityId: resp.id, userId: 'matt', assignmentType: 'primary',
  });
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'charlie', title: 'Set up buyer',
    reason: 'ready', currentResponsibilityId: resp.id,
  });
  assert.equal(wi.ownerUserId, 'matt'); // resolved via primary, not guessed
});

test('#31/#32 cross-organization reads and mutations fail closed', async () => {
  const { work } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'matt', title: 'X', reason: 'Y', ownerUserId: 'matt',
  });
  assert.equal(await work.getInstance(OTHER, wi.id), null); // read: not found
  await assert.rejects(() => work.startWork(OTHER, wi.id, 'attacker')); // mutation: not found
});

test('#35 a general (non-marketplace) work item completes the full lifecycle', async () => {
  const { work, db } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'mike', title: 'Ops chore', reason: 'general', ownerUserId: 'mike',
  });
  await work.startWork(ORG, wi.id, 'mike');
  await work.completeWork({ organizationId: ORG, workInstanceId: wi.id, completedByUserId: 'mike', note: 'done' });
  // general work has no independent-verifier rule, so the same actor may verify.
  const verified = await work.verifyWork({ organizationId: ORG, workInstanceId: wi.id, verifiedByUserId: 'mike' });
  assert.equal(verified.status, 'verified');
  const types = (db.workEvent.__rows as Row[]).map((e) => e.eventType);
  assert.deepEqual(
    ['created', 'assigned', 'started', 'completed', 'verified'].every((t) => types.includes(t)),
    true,
  );
});

test('#26 completed is distinct from verified', async () => {
  const { work } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'mike', title: 'T', reason: 'r', ownerUserId: 'mike',
  });
  await work.startWork(ORG, wi.id, 'mike');
  const completed = await work.completeWork({
    organizationId: ORG, workInstanceId: wi.id, completedByUserId: 'mike', note: 'ok',
  });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.ok(!completed.verifiedAt, 'not verified yet');
  assert.notEqual(completed.status, 'verified');
});

test('#27 setup work cannot be verified by its completer', async () => {
  const { work } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'matt', title: 'Buyer setup',
    reason: 'ready', workType: 'buyer_setup', ownerUserId: 'matt',
  });
  await work.startWork(ORG, wi.id, 'matt');
  await work.completeWork({ organizationId: ORG, workInstanceId: wi.id, completedByUserId: 'matt', note: 'configured' });
  await assert.rejects(
    () => work.verifyWork({ organizationId: ORG, workInstanceId: wi.id, verifiedByUserId: 'matt' }),
    /other than the completer/,
  );
  const ok = await work.verifyWork({ organizationId: ORG, workInstanceId: wi.id, verifiedByUserId: 'charlie' });
  assert.equal(ok.status, 'verified');
});

test('#28 reopening preserves completion and verification history', async () => {
  const { work } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'matt', title: 'Buyer setup',
    reason: 'ready', workType: 'buyer_setup', ownerUserId: 'matt',
  });
  await work.startWork(ORG, wi.id, 'matt');
  await work.completeWork({ organizationId: ORG, workInstanceId: wi.id, completedByUserId: 'matt', note: 'done' });
  await work.verifyWork({ organizationId: ORG, workInstanceId: wi.id, verifiedByUserId: 'charlie' });
  const reopened = await work.reopenWork({
    organizationId: ORG, workInstanceId: wi.id, actorUserId: 'matt', reason: 'buyer changed specs',
  });
  assert.equal(reopened.status, 'reopened');
  assert.ok(reopened.completedAt, 'completion history preserved');
  assert.ok(reopened.verifiedAt, 'verification history preserved');
});

test('#29 blocked requires an active blocker with a reason', async () => {
  const { work, db } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'mike', title: 'T', reason: 'r', ownerUserId: 'mike',
  });
  await work.startWork(ORG, wi.id, 'mike');
  await assert.rejects(() =>
    work.blockWork({ organizationId: ORG, workInstanceId: wi.id, actorUserId: 'mike', blockerType: 'external', reason: '  ' }),
  );
  const { instance } = await work.blockWork({
    organizationId: ORG, workInstanceId: wi.id, actorUserId: 'mike', blockerType: 'external', reason: 'waiting on CallGrid',
  });
  assert.equal(instance.status, 'blocked');
  const active = (db.workBlocker.__rows as Row[]).filter((b) => b.active);
  assert.equal(active.length, 1);
});

test('#30 waiting requires waiting-on information', async () => {
  const { work } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'mike', title: 'T', reason: 'r', ownerUserId: 'mike',
  });
  await work.startWork(ORG, wi.id, 'mike');
  await assert.rejects(() =>
    work.setWaiting({ organizationId: ORG, workInstanceId: wi.id, actorUserId: 'mike', waitingOnType: 'buyer', waitingOnLabel: '' }),
  );
  const waiting = await work.setWaiting({
    organizationId: ORG, workInstanceId: wi.id, actorUserId: 'mike', waitingOnType: 'buyer', waitingOnLabel: 'Acme Corp',
  });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waitingOnLabel, 'Acme Corp');
});

test('#16 handoff records actor, responsibilities, reason and a readiness snapshot', async () => {
  const { work } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'charlie', title: 'Buyer setup',
    reason: 'ready', workType: 'buyer_setup', ownerUserId: 'charlie', currentResponsibilityId: 'resp_contract',
  });
  const handoff = await work.proposeHandoff({
    organizationId: ORG, workInstanceId: wi.id, proposedByUserId: 'charlie',
    toUserId: 'matt', toResponsibilityId: 'resp_setup', reason: 'contracts signed', nextAction: 'Configure in CallGrid',
  });
  assert.equal(handoff.status, 'proposed');
  assert.equal(handoff.fromUserId, 'charlie');
  assert.equal(handoff.toUserId, 'matt');
  assert.equal(handoff.toResponsibilityId, 'resp_setup');
  assert.equal(handoff.reason, 'contracts signed');
  assert.equal(handoff.proposedByUserId, 'charlie');
  assert.ok(handoff.readinessSnapshot);
});

test('#17/#18/#19 handoff is recipient-gated; accept moves ownership, reject preserves it', async () => {
  const base = async () => {
    const { work } = setup();
    const wi = await work.createManualWork({
      organizationId: ORG, createdByUserId: 'charlie', title: 'Buyer setup',
      reason: 'ready', workType: 'buyer_setup', ownerUserId: 'charlie',
    });
    const handoff = await work.proposeHandoff({
      organizationId: ORG, workInstanceId: wi.id, proposedByUserId: 'charlie',
      toUserId: 'matt', toResponsibilityId: 'resp_setup', reason: 'ready',
    });
    return { work, wi, handoff };
  };

  // #17 — only the intended recipient may act.
  {
    const { work, handoff } = await base();
    await assert.rejects(
      () => work.acceptHandoff({ organizationId: ORG, handoffId: handoff.id, acceptedByUserId: 'jonathan' }),
      /intended recipient/,
    );
    await assert.rejects(
      () => work.rejectHandoff({ organizationId: ORG, handoffId: handoff.id, rejectedByUserId: 'jonathan', rejectionReason: 'no' }),
      /intended recipient/,
    );
  }
  // #18 — acceptance changes owner + responsibility.
  {
    const { work, wi, handoff } = await base();
    await work.acceptHandoff({ organizationId: ORG, handoffId: handoff.id, acceptedByUserId: 'matt' });
    const after = await work.getInstance(ORG, wi.id);
    assert.equal(after?.ownerUserId, 'matt');
    assert.equal(after?.currentResponsibilityId, 'resp_setup');
    assert.equal(after?.status, 'in_progress');
  }
  // #19 — rejection preserves existing ownership.
  {
    const { work, wi, handoff } = await base();
    await work.rejectHandoff({ organizationId: ORG, handoffId: handoff.id, rejectedByUserId: 'matt', rejectionReason: 'specs missing' });
    const after = await work.getInstance(ORG, wi.id);
    assert.equal(after?.ownerUserId, 'charlie'); // unchanged
  }
});

test('#10/#11 (integration) asset readiness uses only the current version', async () => {
  const { work } = setup();
  const wi = await work.createManualWork({
    organizationId: ORG, createdByUserId: 'jonathan', title: 'Vendor setup',
    reason: 'assets', workType: 'vendor_setup', ownerUserId: 'jonathan',
  });
  // requirement keyed to the asset kind, category asset_approval.
  await work.addRequirement({
    organizationId: ORG, workInstanceId: wi.id, key: 'creative', label: 'Creative approved',
    category: 'asset_approval', required: true,
  });
  const asset = await work.addAsset({ organizationId: ORG, workInstanceId: wi.id, kind: 'creative', label: 'creative' });
  const v1 = await work.addAssetVersion({ organizationId: ORG, workAssetId: asset.id });
  await work.recordApproval({ organizationId: ORG, workAssetVersionId: v1.id, scope: 'internal', decision: 'approved' });
  await work.recordApproval({ organizationId: ORG, workAssetVersionId: v1.id, scope: 'buyer', decision: 'approved' });
  let readiness = await work.computeReadiness(ORG, wi.id);
  assert.equal(readiness.ready, true, 'v1 approved at both scopes → ready');

  // A new version invalidates the prior approval.
  await work.addAssetVersion({ organizationId: ORG, workAssetId: asset.id });
  readiness = await work.computeReadiness(ORG, wi.id);
  assert.equal(readiness.ready, false, 'v2 has no approvals → not ready');
});

test('responsibility routing resolves through the repository (primary → needs owner)', async () => {
  const { responsibilities } = setup();
  const resp = await responsibilities.ensureResponsibility({
    organizationId: ORG, key: 'CONTRACT_REVIEW', name: 'Contract Review',
  });
  // No assignment yet → Needs Owner.
  let routed = await responsibilities.resolveResponsibleActor(ORG, resp.id);
  assert.equal(routed.via, 'needs_owner');
  await responsibilities.assignResponsibility({ organizationId: ORG, responsibilityId: resp.id, userId: 'charlie' });
  routed = await responsibilities.resolveResponsibleActor(ORG, resp.id);
  assert.equal(routed.userId, 'charlie');
  assert.equal(routed.via, 'primary');
});
