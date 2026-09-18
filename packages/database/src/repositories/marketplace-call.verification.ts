// MarketplaceCall — self-verification (pure + in-memory-Prisma, deterministic).
//
// Follows the repo convention of a co-located verification harness (run via tsx).
// It proves the 18-point spec's correctness invariants WITHOUT a live database by
// driving the repository against a tiny in-memory Prisma fake:
//   • idempotent projection (re-projecting yields one row, not duplicates)
//   • null preservation (absent economics stay null, never 0/false)
//   • tenant isolation (aggregation is org-scoped)
//   • cents-based economics (decimal dollars → integer cents)
//   • duplicate external ids (same provider+externalId merges, never inserts)
//   • re-projecting an older Interaction MERGES: it fills what is unknown and
//     never replaces a settled amount (the backfill that used to overwrite)

import { MarketplaceCallRepository } from './marketplace-call.repository';
import { projectInteractionToMarketplaceCall, type InteractionForProjection } from './marketplace-call-projection';
import type { PrismaClient } from '@prisma/client';

// --- A minimal in-memory Prisma fake (only the methods the repo uses) --------
interface StoredCall extends Record<string, unknown> {
  organizationId: string;
  provider: string;
  externalId: string;
  sourceOccurredAt: Date;
}
class FakePrisma {
  calls = new Map<string, StoredCall>();
  interactions: InteractionForProjection[] = [];

  marketplaceCall = {
    findUnique: async (args: {
      where: { provider_externalId: { provider: string; externalId: string } };
    }): Promise<StoredCall | null> => {
      const { provider, externalId } = args.where.provider_externalId;
      return this.calls.get(`${provider}|${externalId}`) ?? null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<StoredCall> => {
      const key = `${String(args.data.provider)}|${String(args.data.externalId)}`;
      if (this.calls.has(key)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const row = { id: key, ...args.data } as unknown as StoredCall;
      this.calls.set(key, row);
      return row;
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> => {
      const row = [...this.calls.values()].find((r) =>
        Object.entries(args.where).every(([k, v]) => (r[k] ?? null) === (v ?? null)),
      );
      if (!row) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    },
    findMany: async (args: {
      where: { organizationId: string; sourceOccurredAt: { gte: Date; lt: Date } };
    }): Promise<StoredCall[]> => {
      const { organizationId, sourceOccurredAt } = args.where;
      return [...this.calls.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          r.sourceOccurredAt >= sourceOccurredAt.gte &&
          r.sourceOccurredAt < sourceOccurredAt.lt,
      );
    },
    count: async (args: {
      where: { organizationId: string; sourceOccurredAt: { gte: Date; lt: Date } };
    }): Promise<number> => {
      return (await this.marketplaceCall.findMany(args)).length;
    },
  };

  interaction = {
    findMany: async (args: {
      where: { organizationId: string; channel: string; occurredAt: { gte: Date; lt: Date } };
    }): Promise<InteractionForProjection[]> => {
      const { organizationId, occurredAt } = args.where;
      return this.interactions.filter(
        (i) =>
          i.organizationId === organizationId &&
          i.channel === 'PHONE' &&
          i.occurredAt >= occurredAt.gte &&
          i.occurredAt < occurredAt.lt,
      );
    },
  };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[marketplace-call verification] ${msg}`);
}

const T0 = new Date('2026-07-14T10:00:00.000Z');
const SINCE = new Date('2026-07-10T00:00:00.000Z');
const UNTIL = new Date('2026-07-17T00:00:00.000Z');

function call(over: Partial<InteractionForProjection> & { id: string; externalId: string; metadata: unknown }): InteractionForProjection {
  return {
    organizationId: 'org_a',
    provider: 'callgrid',
    channel: 'PHONE',
    occurredAt: T0,
    customer: null,
    ...over,
  };
}

export interface VerificationResult { passed: boolean; checks: string[] }

export async function verifyMarketplaceCall(): Promise<VerificationResult> {
  const checks: string[] = [];

  // --- 1. Pure mapper: cents + null preservation ---------------------------
  const p = projectInteractionToMarketplaceCall(
    call({ id: 'i1', externalId: 'cg-1', metadata: { revenue: 12.5, buyer: 'Acme', buyerId: 'b1', qualified: true } }),
  );
  assert(p !== null, 'a phone call with an external id must project');
  assert(p!.revenueCents === 1250, `revenue 12.5 dollars must become 1250 cents (got ${p!.revenueCents})`);
  assert(p!.payoutCents === null, 'absent payout must be null, not 0');
  assert(p!.costCents === null, 'absent cost must be null, not 0');
  assert(p!.converted === null, 'absent converted must be null, not false');
  assert(p!.monetized === true, 'a present metadata.qualified projects onto the renamed `monetized` field');
  assert(p!.buyerLabel === 'Acme' && p!.buyerExternalId === 'b1', 'attribution id + label must project');
  checks.push('pure mapper: decimal dollars → integer cents; absent values null (not 0/false)');

  // --- 2. Non-projectable rows skip (null), never fabricate ----------------
  assert(projectInteractionToMarketplaceCall(call({ id: 'x', externalId: '', metadata: {}, channel: 'PHONE' })) === null, 'no external id → skip');
  assert(projectInteractionToMarketplaceCall(call({ id: 'x', externalId: 'e', metadata: {}, channel: 'EMAIL' })) === null, 'non-phone → skip');
  assert(
    projectInteractionToMarketplaceCall(call({ id: 'x', externalId: 'e', metadata: {}, customer: { tags: ['demo'] } })) === null,
    'excluded demo customer → skip',
  );
  checks.push('non-projectable rows (no id / non-phone / demo) skip cleanly, never fabricated');

  // --- 3. Idempotent projection + duplicate external ids -------------------
  const fake = new FakePrisma();
  const repo = new MarketplaceCallRepository(fake as unknown as PrismaClient);
  fake.interactions.push(
    call({ id: 'i1', externalId: 'cg-1', metadata: { revenue: 10, payout: 4, cost: 1, buyer: 'Acme', buyerId: 'b1', qualified: true, converted: true } }),
    call({ id: 'i2', externalId: 'cg-2', metadata: { revenue: 20, source: 'Search', sourceId: 's1' } }),
    call({ id: 'org_b_call', externalId: 'cg-3', organizationId: 'org_b', metadata: { revenue: 999 } }),
  );
  const r1 = await repo.projectWindow('org_a', SINCE, UNTIL);
  assert(r1.projected === 2 && r1.skipped === 0, `org_a projects 2 calls (got ${r1.projected})`);
  const r2 = await repo.projectWindow('org_a', SINCE, UNTIL);
  assert(await repo.countWindow('org_a', SINCE, UNTIL) === 2, 're-projecting must not duplicate (idempotent)');
  assert(r2.projected === 2, 'second projection still observes the same 2 rows');
  checks.push('projection is idempotent — re-running merges, never duplicates external ids');

  // --- 4. Tenant isolation -------------------------------------------------
  await repo.projectWindow('org_b', SINCE, UNTIL);
  const aggA = await repo.aggregateWindow('org_a', SINCE, UNTIL);
  const aggB = await repo.aggregateWindow('org_b', SINCE, UNTIL);
  assert(aggA.calls === 2, `org_a sees exactly its 2 calls (got ${aggA.calls})`);
  assert(aggB.calls === 1 && aggB.revenueCents === 99900, 'org_b sees only its own call, in cents');
  checks.push('tenant isolation: aggregation is strictly org-scoped');

  // --- 5. Cents aggregation + coverage + dimensions ------------------------
  assert(aggA.revenueCents === 3000, `org_a revenue = $10 + $20 = 3000 cents (got ${aggA.revenueCents})`);
  assert(aggA.payoutCents === 400 && aggA.callsWithPayout === 1, 'payout summed null-aware with coverage count');
  assert(aggA.callsWithRevenue === 2, 'revenue coverage counts both calls');
  assert(aggA.buyers.length === 1 && aggA.buyers[0]!.label === 'Acme' && aggA.buyers[0]!.revenueCents === 1000, 'buyer dimension aggregates correctly');
  assert(aggA.sources.length === 1 && aggA.sources[0]!.label === 'Search', 'source dimension aggregates correctly');
  checks.push('cents-based economics: null-aware summation + coverage counts + per-dimension rollups');

  // --- 6. Re-projecting an Interaction MERGES -------------------------------
  // cg-2 had no payout; a re-projection that states one fills it. cg-1 had a
  // settled $10; a re-projection that says $50 is a disagreement, not an update,
  // and the settled amount stands -- exactly what stops a stale copy erasing it.
  fake.interactions[0] = call({ id: 'i1', externalId: 'cg-1', metadata: { revenue: 50, payout: 4, cost: 1, buyer: 'Acme', buyerId: 'b1', qualified: true, converted: true } });
  fake.interactions[1] = call({ id: 'i2', externalId: 'cg-2', metadata: { revenue: 20, payout: 7, source: 'Search', sourceId: 's1' } });
  await repo.projectWindow('org_a', SINCE, UNTIL);
  const aggA2 = await repo.aggregateWindow('org_a', SINCE, UNTIL);
  assert(await repo.countWindow('org_a', SINCE, UNTIL) === 2, 're-projecting must not create a new row');
  assert(aggA2.revenueCents === 3000, `a settled amount is not replaced: still $10 + $20 = 3000 cents (got ${aggA2.revenueCents})`);
  assert(aggA2.payoutCents === 1100, `an unknown payout is filled: $4 + $7 = 1100 cents (got ${aggA2.payoutCents})`);
  checks.push('re-projecting an Interaction merges in place: fills the unknown, never replaces the settled');

  return { passed: true, checks };
}
