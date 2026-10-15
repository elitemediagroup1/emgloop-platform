import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketplaceCallRepository } from '../src/repositories/marketplace-call.repository';
const since = new Date('2026-10-14T04:00:00Z');
const until = new Date('2026-10-15T04:00:00Z');
const observedAt = new Date('2026-10-15T13:00:00Z');
const input = { organizationSlug: 'fixture-org', since, until, observedAt, digest: 'a'.repeat(64), reviewedBy: 'reviewer', changes: [{ externalId: 'call1', fromCents: 4, toCents: 16 }, { externalId: 'call2', fromCents: 8, toCents: 0 }] };
function world(options: { failRevision?: boolean; foreignOrg?: boolean; stale?: boolean } = {}) {
  const state = { costs: { call1: 4, call2: options.stale ? 9 : 8 } as Record<string, number>, revisions: [] as Record<string, unknown>[], writes: [] as Record<string, unknown>[] };
  const prisma = { async $transaction(fn: (tx: unknown) => Promise<number>) {
    const costs = { ...state.costs }; const revisions: Record<string, unknown>[] = []; const writes: Record<string, unknown>[] = [];
    const result = await fn({
      organization: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        assert.deepEqual(where, { id: 'org1', slug: 'fixture-org', status: 'ACTIVE' }); return options.foreignOrg ? null : { id: 'org1' };
      } },
      marketplaceCall: { updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { costCents: number } }) => {
        assert.equal(where.organizationId, 'org1'); assert.equal(where.provider, 'callgrid');
        assert.deepEqual(where.sourceOccurredAt, { gte: since, lt: until });
        assert.deepEqual(Object.keys(data), ['costCents']);
        const id = String(where.externalId); if (costs[id] !== where.costCents) return { count: 0 };
        costs[id] = data.costCents; writes.push(data); return { count: 1 };
      } },
      providerFactRevision: { create: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.failRevision) throw new Error('revision write failed'); revisions.push(data); return { id: 'rev' };
      } },
    });
    state.costs = costs; state.revisions.push(...revisions); state.writes.push(...writes); return result;
  } };
  return { state, repo: new MarketplaceCallRepository(prisma as never) };
}

test('reviewed increases and explicit reductions append provenance and change only cost atomically', async () => {
  const w = world(); assert.equal(await w.repo.applyReviewedCosts('org1', input), 2);
  assert.deepEqual(w.state.costs, { call1: 16, call2: 0 });
  assert.equal(w.state.revisions.length, 2);
  assert.equal(w.state.revisions[0]!.fromValue, '4'); assert.equal(w.state.revisions[0]!.toValue, '16');
  assert.equal(w.state.revisions[0]!.appliedAt, observedAt); assert.equal(w.state.revisions[0]!.observationSource, 'API_RECOVERY');
  assert.match(String(w.state.revisions[0]!.reason), /reviewer=reviewer/);
});

test('failed evidence writes, a stale later call and foreign organizations roll back the entire correction', async () => {
  for (const options of [{ failRevision: true }, { stale: true }, { foreignOrg: true }]) {
    const w = world(options); const before = { ...w.state.costs };
    await assert.rejects(w.repo.applyReviewedCosts('org1', input));
    assert.deepEqual(w.state.costs, before); assert.equal(w.state.revisions.length, 0); assert.equal(w.state.writes.length, 0);
  }
});

test('invalid cents, duplicate identities, invalid approval and unfinished intervals refuse', async () => {
  for (const over of [{ changes: [...input.changes, input.changes[0]!] }, { digest: 'no' }, { until: new Date('2026-10-16') }, { changes: [{ externalId: 'call1', fromCents: 4, toCents: -1 }] }]) {
    const w = world(); await assert.rejects(w.repo.applyReviewedCosts('org1', { ...input, ...over }), /INVALID_COST_CORRECTION/); assert.equal(w.state.writes.length, 0);
  }
});
