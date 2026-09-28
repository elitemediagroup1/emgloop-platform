// Campaigns / CallGrid entity references (production, 2026-09-28: every Campaigns refresh HELD as
// INVALID_ENTITY_REFS). The rules may only ever name each canonical entity once, validly, in ORGANIZATION
// scope; a model answer can never add an invalid one -- it is rejected by the output contract before any
// write, and the digest keeps the rule's references. The real-repository proof is in
// intelligence-freshness.postgres.test.ts ("CAMPAIGNS: ...").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordedModelProvider, aiCatalogCapabilities, AI_ROUTING_POLICY, AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET } from '@emgloop/providers';
import { entityRefListRefusals, intelligenceSignalsRefusals, type AiModelResult, type AiProviderPolicy } from '@emgloop/shared';

import { AiRuntimeGateway, InMemoryAiUsageLedger } from '../src/services/ai-runtime/gateway';
import { DomainReadingService } from '../src/services/ai-runtime/domain-reading.service';
import { callgridRule, campaignsDomainProducer, campaignsRule } from '../src/services/intelligence-fabric/domains/callgrid';

const NOW = new Date('2026-09-28T12:00:00Z');
const ORG = 'demo-org-0001';
const REF = 'provider_member:callgrid:campaign:c1';

type Dim = { key: string; label: string; calls: number; monetized: number; converted: number; revenueCents: number; payoutCents: number; costCents: number; callsWithRevenue: number; callsWithPayout: number; callsWithCost: number };
const dim = (key: string, calls: number, monetized: number, revenueCents = 0): Dim => ({ key, label: key, calls, monetized, converted: 0, revenueCents, payoutCents: 0, costCents: 0, callsWithRevenue: revenueCents > 0 ? calls : 0, callsWithPayout: 0, callsWithCost: 0 });
const agg = (campaigns: Dim[], buyers: Dim[] = []) => {
  const calls = campaigns.reduce((n, c) => n + c.calls, 0);
  const revenueCents = buyers.reduce((n, b) => n + b.revenueCents, 0);
  return { calls, monetized: campaigns.reduce((n, c) => n + c.monetized, 0), converted: 0, revenueCents, payoutCents: 0, costCents: 0, callsWithRevenue: revenueCents > 0 ? calls : 0, callsWithPayout: 0, callsWithCost: 0, buyers, vendors: [], sources: [], campaigns };
};
const ctx = (current: ReturnType<typeof agg>, prior: ReturnType<typeof agg> | null) => ({ current, prior, lastDayCalls: 3, windowStart: NOW, windowEnd: NOW }) as never;

function assertCanonical(what: string, r: ReturnType<typeof campaignsRule>) {
  assert.deepEqual(entityRefListRefusals(r.entityRefs, 32, 'ORGANIZATION'), [], `${what}: digest entityRefs`);
  assert.deepEqual(intelligenceSignalsRefusals(r.signals, { scope: 'ORGANIZATION', producerKind: 'RULE' }), [], `${what}: signals`);
  for (const s of r.signals) for (const e of s.entities ?? []) assert.ok(r.entityRefs.includes(e), `${what}: a signal names an entity the digest does not`);
}

test('the production shape: a campaign that moved sharply AND sold nothing is named once, with both of its signals', () => {
  const r = campaignsRule(ctx(agg([dim('c1', 40, 0), dim('c2', 30, 30)]), agg([dim('c1', 10, 0), dim('c2', 30, 30)])), NOW);
  assert.deepEqual(r.entityRefs, [REF]);
  assert.deepEqual(r.signals.filter((s) => s.entities?.includes(REF)).map((s) => s.kind).sort(), ['CHANGE', 'RISK']);
  assertCanonical('production shape', r);
});

test('every rule reading over a sweep of campaign and buyer mixes names only valid, unique, organization-scope references', () => {
  // Deterministic sweep: moves up and down, campaigns gone quiet, unsold, keys at the grammar's edges, and
  // keys that cannot be a reference (they are skipped, never mangled).
  const keys = ['c1', 'c2', 'C-3', 'camp.4', 'x_5', 'k'.repeat(128), 'has space', 'semi;colon', 'ünï', ''];
  let n = 0;
  for (let seed = 1; seed <= 400; seed += 1) {
    const pick = (i: number) => ((seed * 7919 + i * 104729) % 97);
    const cur = keys.filter((_, i) => pick(i) % 3 !== 0).map((k, i) => dim(k, pick(i + 11) % 60, pick(i + 13) % 4 === 0 ? 0 : pick(i + 17) % 30));
    const pri = keys.filter((_, i) => pick(i + 5) % 4 !== 0).map((k, i) => dim(k, pick(i + 19) % 60, pick(i + 23) % 30));
    const buyers = keys.slice(0, 4).map((k, i) => dim(k, 10, 10, (pick(i + 29) + 1) * 1000));
    for (const prior of [agg(pri, buyers), null]) {
      assertCanonical(`campaigns seed ${seed}`, campaignsRule(ctx(agg(cur, buyers), prior), NOW));
      assertCanonical(`callgrid seed ${seed}`, callgridRule(ctx(agg(cur, buyers), prior), NOW));
      n += 1;
    }
  }
  assert.equal(n, 800);
});

test('signal keys: the established keys are unchanged; an upper-case or over-long campaign id still gets a valid, distinct key', () => {
  const prior = agg([dim('c1', 10, 0), dim('Camp-A', 10, 0), dim('camp-a', 10, 0), dim(`${'z'.repeat(60)}1`, 10, 0), dim(`${'z'.repeat(60)}2`, 10, 0)]);
  const current = agg([dim('c1', 40, 0), dim('Camp-A', 40, 0), dim('camp-a', 40, 0), dim(`${'z'.repeat(60)}1`, 40, 0), dim(`${'z'.repeat(60)}2`, 40, 0)]);
  const r = campaignsRule(ctx(current, prior), NOW);
  const keys = r.signals.map((s) => s.key);
  assert.ok(keys.includes('campaign.provider_member_callgrid_campaign_c1') && keys.includes('unsold.c1'), 'a plain id keeps the key it had');
  assert.equal(new Set(keys).size, keys.length, 'no two signals share a key');
  assertCanonical('upper-case and long ids', r);
});

const POLICY: readonly AiProviderPolicy[] = [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }];
const modelSaying = (entities: string[]): AiModelResult => ({
  output: { json: { schemaId: 'domain-reading.v1', reading: { statement: 'One campaign is growing on calls nobody buys.', status: 'ATTENTION', confidence: 'MEDIUM' }, signals: [{ key: 'unsold-growth', kind: 'RISK', knowledge: 'INFERRED', statement: 'A growing campaign is not being bought.', entities, evidenceRefs: ['marketplace_calls:7d'], occurredAt: null, dueAt: null, confidence: 'MEDIUM', severity: 'HIGH', owedBy: null }], limitations: [] } },
  toolCalls: [],
  stopReason: 'END',
  usage: { inputTokens: 900, outputTokens: 120 },
  providerRequestId: 'req_1',
  reportedModel: 'claude-opus-5',
  latencyMs: 40,
});

async function readWithModel(result: AiModelResult) {
  const gateway = new AiRuntimeGateway(
    { activation: { enabled: true, organizations: [ORG], tasks: ['campaigns.domain.reading'], providers: ['anthropic'] }, policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
    { providers: [new RecordedModelProvider('anthropic', [{ modelId: 'claude-opus-5', result }], (m) => aiCatalogCapabilities('anthropic', m))], ledger: new InMemoryAiUsageLedger(), authorize: async () => true, now: () => NOW, newInvocationId: () => `inv_${Math.random()}`, providerPolicies: async () => POLICY },
  );
  const current = agg([dim('c1', 40, 0), dim('c2', 30, 30)]);
  const prior = agg([dim('c1', 10, 0), dim('c2', 30, 30)]);
  const calls = { firstCallAt: async () => new Date('2026-01-01'), aggregateWindow: async (_o: string, from: Date) => (from.getTime() < NOW.getTime() - 8 * 24 * 3600_000 ? prior : current), organizationIdsWithCallsSince: async () => [ORG] };
  const p = campaignsDomainProducer(calls as never, { modelEnabled: () => true, reader: new DomainReadingService(gateway), principalFor: async () => ({ organizationId: ORG, userId: 'user_operator' }) });
  const target = { scope: 'ORGANIZATION', organizationId: ORG, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;
  const g = await p.gather(target, NOW);
  const r = (await p.read(target, (g as { context: never }).context, 'campaigns:fp', NOW)) as { modelStage?: string; digest: { entityRefs: string[]; content: { signals: { key: string; entities?: string[] }[] } } };
  return r;
}

test('a model-added signal naming the supplied campaign is kept; the digest still names it once', async () => {
  const r = await readWithModel(modelSaying([REF]));
  assert.equal(r.modelStage, 'MODEL_READ');
  assert.deepEqual(r.digest.entityRefs, [REF]);
  assert.deepEqual(r.digest.content.signals.find((s) => s.key === 'm.unsold-growth')!.entities, [REF]);
});

test('a model can never introduce an invalid entity reference: duplicate, unsupplied, malformed or private refs reject the answer before any write', async () => {
  for (const [entities, code] of [
    [[REF, REF], 'REJECTED_OUTPUT:WRONG_SCHEMA'],
    [['provider_member:callgrid:campaign:c9'], 'REJECTED_OUTPUT:ENTITY_NOT_SUPPLIED'],
    [['provider_member:callgrid:campaign:has space'], 'REJECTED_OUTPUT:ENTITY_NOT_SUPPLIED'],
    [['campaign_name:Acme'], 'REJECTED_OUTPUT:ENTITY_NOT_SUPPLIED'],
    [['work_event:ev1'], 'REJECTED_OUTPUT:ENTITY_NOT_SUPPLIED'],
  ] as const) {
    const r = await readWithModel(modelSaying([...entities]));
    assert.equal(r.modelStage, code, JSON.stringify(entities));
    assert.deepEqual(r.digest.entityRefs, [REF], 'the rule reading, with its one valid reference');
    assert.ok(!r.digest.content.signals.some((s) => s.key.startsWith('m.')), 'nothing of the rejected answer is kept');
  }
});
