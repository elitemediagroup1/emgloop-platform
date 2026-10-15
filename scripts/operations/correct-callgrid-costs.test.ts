import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCostCorrection } from './correct-callgrid-costs';
import type { AuditDeps } from './audit-callgrid-financials';
const request = { organization: 'fixture-org', date: '2026-10-14', apiKey: 'not-for-output', now: new Date('2026-10-15T13:00:00Z'), mode: 'preview' as const };
function world(options: { cost?: number | null; outcome?: 'COMPLETE' | 'TRUNCATED'; localCost?: number | null; missingCall?: boolean } = {}) {
  const calls: unknown[] = [];
  const deps: AuditDeps & { corrections: { applyReviewedCosts(...args: unknown[]): Promise<number> } } = {
    organizations: { findBySlug: async () => ({ id: 'org1', status: 'ACTIVE' }) },
    provider: { read: async () => ({ outcome: options.outcome ?? 'COMPLETE', records: 1, pages: 1, refused: [], events: [{ externalId: 'call1', rawEventType: 'completed', occurredAt: new Date('2026-10-14T15:00:00Z'), payload: { id: 'call1', revenue: 0, payout: 0, cost: options.cost === undefined ? 0.16 : options.cost } }] }) },
    calls: { listWindowForReconciliation: async () => options.missingCall ? [] : [{ externalId: 'call1', sourceOccurredAt: new Date('2026-10-14T15:00:00Z'), connectedDurationSeconds: 1, revenueCents: null, payoutCents: null, costCents: options.localCost === undefined ? 4 : options.localCost, buyerLabel: null, campaignLabel: null, sourceLabel: null, monetized: false, converted: null, duplicate: null }] },
    corrections: { applyReviewedCosts: async (...args) => { calls.push(args); return 1; } },
  };
  return { deps, calls };
}

test('preview preserves unknown revenue and emits exact cost-only changes without writes', async () => {
  const w = world(); const result = await runCostCorrection(request, w.deps);
  assert.equal(result.outcome, 'PREVIEW'); assert.equal(w.calls.length, 0);
  assert.deepEqual(result.plan.changes, [{ externalId: 'call1', fromCents: 4, toCents: 16, campaign: null }]);
  assert.match(result.plan.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /not-for-output|transcript|caller/);
});

test('apply re-reads and binds approval to identities, old amounts, proposed amounts and organization', async () => {
  const w = world(); const preview = await runCostCorrection(request, w.deps);
  const apply = { ...request, mode: 'apply' as const, expectedDigest: preview.plan.digest, confirmation: 'CORRECT COSTS fixture-org 2026-10-14', reviewedBy: 'reviewer' };
  assert.equal((await runCostCorrection(apply, w.deps)).applied, 1);
  const changedProvider = world({ cost: 0.20 });
  await assert.rejects(runCostCorrection(apply, changedProvider.deps), /COST_PLAN_CHANGED/); assert.equal(changedProvider.calls.length, 0);
  const changedLocal = world({ localCost: 8 });
  await assert.rejects(runCostCorrection(apply, changedLocal.deps), /COST_PLAN_CHANGED/); assert.equal(changedLocal.calls.length, 0);
  await assert.rejects(runCostCorrection({ ...apply, confirmation: 'yes' }, w.deps), /REVIEW_REQUIRED/);
});

test('unknown cost, incomplete reads, missing identities, current days and invalid modes never reach writes', async () => {
  for (const options of [{ cost: null }, { outcome: 'TRUNCATED' as const }, { missingCall: true }]) {
    const w = world(options); await assert.rejects(runCostCorrection(request, w.deps), /COMPLETE_COST_EVIDENCE/); assert.equal(w.calls.length, 0);
  }
  const w = world();
  await assert.rejects(runCostCorrection({ ...request, date: '2026-10-15' }, w.deps), /COMPLETED_DAY_REQUIRED/);
  await assert.rejects(runCostCorrection({ ...request, mode: 'bad' as never }, w.deps), /INVALID_MODE/);
});

test('explicit zero, reductions and unknown local costs require the same reviewed plan', async () => {
  for (const options of [{ cost: 0 }, { cost: 0.01 }, { localCost: null }]) {
    const w = world(options); const p = await runCostCorrection(request, w.deps);
    assert.equal(p.plan.changes.length, 1); assert.equal(w.calls.length, 0);
  }
});

test('workflow is manual, main-only, allowlisted and tests before production credentials', () => {
  const s = readFileSync(new URL('../../.github/workflows/correct-callgrid-costs.yml', import.meta.url), 'utf8');
  assert.match(s, /workflow_dispatch:/); assert.doesNotMatch(s, /schedule:|pull_request:|\n  push:/);
  assert.match(s, /github.ref == 'refs\/heads\/main'/); assert.match(s, /vars.ROUTINE_POLL_ORGANIZATIONS/);
  assert.ok(s.indexOf('node --import tsx --test') < s.indexOf('secrets.DIRECT_DATABASE_URL'));
  assert.match(s, /default: preview/); assert.match(s, /github.actor/);
});
