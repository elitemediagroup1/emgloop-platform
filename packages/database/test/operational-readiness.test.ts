// Operational Readiness Engine (Sprint 27B, PR #121B) — deterministic harness.
//
// Runs with the built-in Node test runner (node --import tsx --test). Requires NO
// database: the kernel and adapters are pure, and the orchestration service is
// driven against a tiny in-memory fake Prisma client (same approach as
// work-intelligence.test.ts). The decisions pinned here are decisions about
// MEANING: required vs not-required (applicability), expired/revoked evidence
// revokes readiness, waiting ≠ incomplete ≠ blocked, version-specific approvals,
// readiness revocation on a new version, responsibility routing, completion
// percentages, and that the engine SUGGESTS but never creates work.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateReadiness,
  type ReadinessRequest,
  type ReadinessSubject,
} from '../src/services/operational-readiness';
import {
  BUYER_PROCESS_TYPE,
  VENDOR_PROCESS_TYPE,
  type BuyerReadinessEvidence,
  type BuyerRequirementKey,
  type VendorReadinessEvidence,
  type RequirementEvidenceInput,
} from '../src/services/operational-readiness.adapters';
import { OperationalReadinessService } from '../src/services/operational-readiness.service';
import { ResponsibilityRepository } from '../src/repositories/responsibility.repository';
import type { ApprovalLike } from '../src/repositories/work-intelligence.policy';

const NOW = new Date('2026-07-20T00:00:00Z');
const BUYER_SUBJECT: ReadinessSubject = { attributionType: 'destination', label: 'Acme Roofing (dest-42)' };
const VENDOR_SUBJECT: ReadinessSubject = { attributionType: 'source', label: 'BlueSky Media (src-7)' };

// --- evidence builders -----------------------------------------------------
const complete = (): RequirementEvidenceInput => ({ status: 'complete' });
const signed = (): RequirementEvidenceInput => ({ status: 'signed' });

function buyerSpecsComplete(): Partial<Record<BuyerRequirementKey, RequirementEvidenceInput>> {
  return {
    destination_specs: complete(),
    routing_specs: complete(),
    operating_hours: complete(),
    required_tags: complete(),
    call_requirements: complete(),
  };
}
function buyerContractsSigned(): Partial<Record<BuyerRequirementKey, RequirementEvidenceInput>> {
  return { msa: signed(), io: signed(), payout_terms: signed(), caps: signed() };
}
function buyerRequest(evidence: BuyerReadinessEvidence): ReadinessRequest<BuyerReadinessEvidence> {
  return { processType: BUYER_PROCESS_TYPE, subject: BUYER_SUBJECT, evidence, now: NOW };
}
function vendorRequest(evidence: VendorReadinessEvidence): ReadinessRequest<VendorReadinessEvidence> {
  return { processType: VENDOR_PROCESS_TYPE, subject: VENDOR_SUBJECT, evidence, now: NOW };
}

// =====================================================================
// Applicability — required vs not required
// =====================================================================

test('#B1 non-applicable contract requirements never fail readiness', () => {
  // No contract applies → MSA/IO/payout/caps are not required; the 5 operational
  // specs are all complete → the destination is READY.
  const r = evaluateReadiness(
    buyerRequest({ contractApplicable: false, requirements: buyerSpecsComplete() }),
  );
  assert.equal(r.state, 'ready');
  assert.equal(r.requiredCount, 5, 'only the 5 always-required specs count');
  assert.equal(r.completionPct, 100);
  assert.equal(r.confidenceLevel, 'high');
  // Contract items surface as informational, never as failures.
  const naKeys = r.notApplicable.map((x) => x.key).sort();
  assert.deepEqual(naKeys, ['caps', 'io', 'msa', 'other_setup_info', 'payout_terms']);
});

test('#B2 applicable-but-unsigned contracts make the process incomplete (not ready)', () => {
  const r = evaluateReadiness(
    buyerRequest({ contractApplicable: true, requirements: buyerSpecsComplete() }),
  );
  assert.equal(r.state, 'incomplete');
  assert.equal(r.requiredCount, 9); // 4 contract + 5 spec
  assert.equal(r.satisfiedCount, 5);
  assert.equal(r.completionPct, 56); // 5/9
  // The next responsibility is the owner of the first actionable gap (a contract).
  assert.equal(r.nextResponsibilityKey, 'CONTRACT_REVIEW');
  assert.equal(r.disposition, 'suggested_handoff');
});

test('#B3 fully satisfied buyer with a contract → ready and eligible to advance', () => {
  const r = evaluateReadiness(
    buyerRequest({
      contractApplicable: true,
      requirements: { ...buyerContractsSigned(), ...buyerSpecsComplete() },
    }),
  );
  assert.equal(r.state, 'ready');
  assert.equal(r.completionPct, 100);
  assert.equal(r.disposition, 'suggested_handoff');
  assert.equal(r.nextResponsibilityKey, 'CALLGRID_OPTIMIZATION'); // downstream owner
});

test('unknown evidence never becomes ready', () => {
  const reqs = buyerSpecsComplete();
  reqs.destination_specs = { status: 'unknown' };
  const r = evaluateReadiness(buyerRequest({ contractApplicable: false, requirements: reqs }));
  assert.equal(r.state, 'incomplete');
  assert.notEqual(r.state, 'ready');
});

// =====================================================================
// Expired / revoked evidence revokes readiness
// =====================================================================

test('#B4 expired contract evidence revokes readiness', () => {
  const contracts = buyerContractsSigned();
  contracts.msa = { status: 'signed', expiresAt: new Date('2020-01-01T00:00:00Z') };
  const r = evaluateReadiness(
    buyerRequest({ contractApplicable: true, requirements: { ...contracts, ...buyerSpecsComplete() } }),
  );
  assert.equal(r.state, 'incomplete');
  assert.ok(r.unsatisfied.some((x) => x.key === 'msa' && x.facet === 'expired'));
  assert.ok(r.warnings.some((w) => /expired/i.test(w)));
});

test('#B5 revoked evidence revokes readiness', () => {
  const contracts = buyerContractsSigned();
  contracts.io = { status: 'revoked' };
  const r = evaluateReadiness(
    buyerRequest({ contractApplicable: true, requirements: { ...contracts, ...buyerSpecsComplete() } }),
  );
  assert.equal(r.state, 'incomplete');
  assert.ok(r.unsatisfied.some((x) => x.key === 'io' && x.facet === 'revoked'));
  assert.ok(r.warnings.some((w) => /revoked/i.test(w)));
});

// =====================================================================
// Waiting vs incomplete vs blocked — "Not Ready" is differentiated
// =====================================================================

test('#B6 a purely external dependency is WAITING (attention), not executable work', () => {
  // Everything satisfied except the MSA, which is awaiting the buyer's signature.
  const contracts = { io: signed(), payout_terms: signed(), caps: signed() };
  const r = evaluateReadiness(
    buyerRequest({
      contractApplicable: true,
      requirements: {
        ...contracts,
        msa: { status: 'under_review', waitingParty: 'buyer' },
        ...buyerSpecsComplete(),
      },
    }),
  );
  assert.equal(r.state, 'waiting');
  assert.equal(r.disposition, 'attention');
  assert.equal(r.nextResponsibilityKey, null, 'no internal actor for a pure external wait');
  assert.ok(r.informationalNotes.some((n) => /waiting on buyer/i.test(n)));
});

test('#B7 a process-wide blocker forces the BLOCKED state', () => {
  const r = evaluateReadiness({
    ...buyerRequest({ contractApplicable: false, requirements: buyerSpecsComplete() }),
    blockers: [{ reason: 'CallGrid account suspended' }],
  });
  assert.equal(r.state, 'blocked');
  assert.equal(r.disposition, 'attention');
  assert.ok(r.warnings.some((w) => /suspended/i.test(w)));
});

test('#B8 a per-requirement blocker blocks the process and marks that requirement', () => {
  const r = evaluateReadiness({
    ...buyerRequest({ contractApplicable: false, requirements: buyerSpecsComplete() }),
    blockers: [{ requirementKey: 'destination_specs', reason: 'awaiting IT firewall change' }],
  });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blocked.some((x) => x.key === 'destination_specs'));
});

// =====================================================================
// Vendor readiness + version-specific approvals
// =====================================================================

const A_ID = 'asset_creative_1';
function vendorAssetSatisfiedBase(): Partial<Record<string, RequirementEvidenceInput>> {
  return {
    campaign: { status: 'received' },
    creatives_submitted: complete(),
    landing_pages: complete(),
    urls: complete(),
    stored_final_versions: { status: 'received' },
  };
}
function approvals(...specs: Array<{ v: string; scope: 'internal' | 'buyer'; decidedAt: number }>): ApprovalLike[] {
  return specs.map((s) => ({
    workAssetVersionId: s.v,
    scope: s.scope,
    decision: 'approved',
    decidedAt: new Date(s.decidedAt),
  }));
}

test('#V1 vendor is ready when the current creative version is approved by both scopes', () => {
  const r = evaluateReadiness(
    vendorRequest({
      requirements: vendorAssetSatisfiedBase(),
      creativeAsset: {
        asset: { id: A_ID, currentVersion: 1 },
        versions: [{ id: 'v1', workAssetId: A_ID, version: 1 }],
        approvals: approvals(
          { v: 'v1', scope: 'internal', decidedAt: 1 },
          { v: 'v1', scope: 'buyer', decidedAt: 2 },
        ),
      },
    }),
  );
  assert.equal(r.state, 'ready');
  assert.equal(r.completionPct, 100);
});

test('#V2 a NEW creative version inherits no approval → readiness is revoked', () => {
  const r = evaluateReadiness(
    vendorRequest({
      requirements: vendorAssetSatisfiedBase(),
      creativeAsset: {
        asset: { id: A_ID, currentVersion: 2 }, // bumped to v2
        versions: [
          { id: 'v1', workAssetId: A_ID, version: 1 },
          { id: 'v2', workAssetId: A_ID, version: 2 },
        ],
        // v1 fully approved; v2 has nothing.
        approvals: approvals(
          { v: 'v1', scope: 'internal', decidedAt: 1 },
          { v: 'v1', scope: 'buyer', decidedAt: 2 },
        ),
      },
    }),
  );
  assert.notEqual(r.state, 'ready');
  // internal approval is internally actionable → incomplete, routed to review.
  assert.equal(r.state, 'incomplete');
  assert.equal(r.nextResponsibilityKey, 'CREATIVE_REVIEW');
  assert.ok(r.unsatisfied.some((x) => x.key === 'internal_approval'));
});

test('#V3 internal approval is not buyer approval — buyer scope pending → WAITING on buyer', () => {
  const r = evaluateReadiness(
    vendorRequest({
      requirements: vendorAssetSatisfiedBase(),
      creativeAsset: {
        asset: { id: A_ID, currentVersion: 1 },
        versions: [{ id: 'v1', workAssetId: A_ID, version: 1 }],
        approvals: approvals({ v: 'v1', scope: 'internal', decidedAt: 1 }), // internal only
      },
    }),
  );
  // Internal approved (satisfied); only buyer_approval remains, and it waits on
  // the buyer → the process is WAITING, not incomplete.
  assert.equal(r.state, 'waiting');
  assert.ok(r.satisfied.some((x) => x.key === 'internal_approval'));
  assert.ok(r.unsatisfied.some((x) => x.key === 'buyer_approval' && x.facet === 'waiting'));
});

test('#V4 missing creative asset entirely → both approvals unsatisfied, incomplete', () => {
  const r = evaluateReadiness(
    vendorRequest({ requirements: vendorAssetSatisfiedBase(), creativeAsset: null }),
  );
  assert.equal(r.state, 'incomplete'); // internal_approval is internally actionable
  assert.ok(r.unsatisfied.some((x) => x.key === 'internal_approval'));
  assert.ok(r.unsatisfied.some((x) => x.key === 'buyer_approval'));
});

// =====================================================================
// Completion percentage
// =====================================================================

test('completion percentage reflects satisfied / applicable', () => {
  const reqs = buyerSpecsComplete();
  delete reqs.operating_hours; // leave 1 of 5 unsatisfied
  delete reqs.required_tags; // leave 2 of 5 unsatisfied
  const r = evaluateReadiness(buyerRequest({ contractApplicable: false, requirements: reqs }));
  assert.equal(r.requiredCount, 5);
  assert.equal(r.satisfiedCount, 3);
  assert.equal(r.completionPct, 60);
});

// =====================================================================
// The engine never creates work — dispositions only suggest.
// =====================================================================

test('every disposition is advisory (no_action | attention | suggested_handoff)', () => {
  const ready = evaluateReadiness(
    buyerRequest({ contractApplicable: false, requirements: buyerSpecsComplete() }),
  );
  assert.ok(['no_action', 'attention', 'suggested_handoff'].includes(ready.disposition));
});

// =====================================================================
// Orchestration service — Responsibility → Person → Suggested Handoff
// =====================================================================

// Minimal in-memory Prisma fake: only the two responsibility delegates are used.
type Row = Record<string, any>;
let seq = 0;
const nid = () => 'id_' + ++seq;
const matches = (row: Row, where: Row) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
function delegate(defaults: () => Row) {
  const rows: Row[] = [];
  return {
    __rows: rows,
    async create({ data }: { data: Row }) {
      const row = { id: nid(), ...defaults(), ...data };
      rows.push(row);
      return row;
    },
    async findFirst({ where }: { where?: Row } = {}) {
      return rows.find((r) => matches(r, where ?? {})) ?? null;
    },
    async findMany({ where }: { where?: Row } = {}) {
      return rows.filter((r) => matches(r, where ?? {}));
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((r) => matches(r, where));
      Object.assign(row, data);
      return row;
    },
  };
}
function fakeDb() {
  return {
    responsibility: delegate(() => ({ active: true, createdAt: NOW })),
    responsibilityAssignment: delegate(() => ({ active: true, assignmentType: 'primary', assignedAt: NOW })),
  } as any;
}
const ORG = 'org_A';

async function seedResponsibility(db: any, key: string, users: Array<{ userId: string; type?: 'primary' | 'secondary' }>) {
  const resp = await db.responsibility.create({ data: { organizationId: ORG, key, name: key } });
  for (const u of users) {
    await db.responsibilityAssignment.create({
      data: { organizationId: ORG, responsibilityId: resp.id, userId: u.userId, assignmentType: u.type ?? 'primary' },
    });
  }
  return resp;
}

test('#R1 a suggested handoff resolves the next responsibility to its assigned person', async () => {
  const db = fakeDb();
  await seedResponsibility(db, 'CONTRACT_REVIEW', [{ userId: 'charlie' }]);
  const service = new OperationalReadinessService(new ResponsibilityRepository(db));

  const assessment = await service.assess(
    ORG,
    buyerRequest({ contractApplicable: true, requirements: buyerSpecsComplete() }),
  );
  assert.equal(assessment.state, 'incomplete');
  assert.ok(assessment.suggestedHandoff);
  assert.equal(assessment.suggestedHandoff?.responsibilityKey, 'CONTRACT_REVIEW');
  assert.equal(assessment.suggestedHandoff?.suggestedToUserId, 'charlie');
  assert.equal(assessment.suggestedHandoff?.routedVia, 'primary');
});

test('#R2 routing never guesses: an ambiguous responsibility yields no user', async () => {
  const db = fakeDb();
  await seedResponsibility(db, 'CONTRACT_REVIEW', [
    { userId: 'charlie' },
    { userId: 'dana' }, // two active primaries → ambiguous
  ]);
  const service = new OperationalReadinessService(new ResponsibilityRepository(db));
  const assessment = await service.assess(
    ORG,
    buyerRequest({ contractApplicable: true, requirements: buyerSpecsComplete() }),
  );
  assert.equal(assessment.suggestedHandoff?.suggestedToUserId, null);
  assert.equal(assessment.suggestedHandoff?.routedVia, 'ambiguous');
});

test('#R3 an unseeded responsibility resolves to Needs Owner, never an error', async () => {
  const db = fakeDb(); // no responsibilities seeded
  const service = new OperationalReadinessService(new ResponsibilityRepository(db));
  const assessment = await service.assess(
    ORG,
    buyerRequest({ contractApplicable: true, requirements: buyerSpecsComplete() }),
  );
  assert.equal(assessment.suggestedHandoff?.responsibilityId, null);
  assert.equal(assessment.suggestedHandoff?.suggestedToUserId, null);
  assert.equal(assessment.suggestedHandoff?.routedVia, 'needs_owner');
});

test('#R4 waiting / attention states produce no suggested handoff', async () => {
  const db = fakeDb();
  const service = new OperationalReadinessService(new ResponsibilityRepository(db));
  const assessment = await service.assess(ORG, {
    ...buyerRequest({ contractApplicable: false, requirements: buyerSpecsComplete() }),
    blockers: [{ reason: 'account suspended' }],
  });
  assert.equal(assessment.state, 'blocked');
  assert.equal(assessment.disposition, 'attention');
  assert.equal(assessment.suggestedHandoff, null);
});
