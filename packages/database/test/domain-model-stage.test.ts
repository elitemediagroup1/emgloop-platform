// Domain model stages through the REAL AiRuntimeGateway (a RecordedModelProvider: no key, no network,
// no bill). The production defect of 2026-09-28: every domain model stage was refused before any
// reservation -- its context blocks were not minted inside the organization (`<org>::`), so the gateway
// answered CONTEXT_REFUSED, the kit silently wrote a RULE digest, and the ledger showed zero runs.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { RecordedModelProvider, aiCatalogCapabilities, AI_ROUTING_POLICY, AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET } from '@emgloop/providers';
import type { AiActivation, AiModelResult, AiProviderPolicy } from '@emgloop/shared';

import { AiRuntimeGateway, InMemoryAiUsageLedger } from '../src/services/ai-runtime/gateway';
import { DomainReadingService } from '../src/services/ai-runtime/domain-reading.service';
import { calendarDomainProducer } from '../src/services/intelligence-fabric/domains/calendar';
import { callgridDomainProducer } from '../src/services/intelligence-fabric/domains/callgrid';

const ORG = 'demo-org-0001';
const USER = 'user_calendar_1';
const OPERATOR = 'user_operator_1';
const NOW = new Date('2026-09-28T12:00:00Z');
const POLICY: readonly AiProviderPolicy[] = [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }];
const TASKS = ['telegram.content.triage', 'calendar.domain.reading', 'callgrid.domain.reading'];

const reading = (statement: string, ref: string): AiModelResult => ({
  output: { json: { schemaId: 'domain-reading.v1', reading: { statement, status: 'WATCH', confidence: 'MEDIUM' }, signals: [{ key: 'model-view', kind: 'ATTENTION', knowledge: 'INFERRED', statement, entities: [], evidenceRefs: [ref], occurredAt: null, dueAt: null, confidence: 'MEDIUM', severity: 'MEDIUM', owedBy: null }], limitations: [] } },
  toolCalls: [],
  stopReason: 'END',
  usage: { inputTokens: 900, outputTokens: 120 },
  providerRequestId: 'req_1',
  reportedModel: 'claude-opus-5',
  latencyMs: 40,
});

function runtime(result: AiModelResult, ledger = new InMemoryAiUsageLedger()) {
  const activation: AiActivation = { enabled: true, organizations: [ORG], tasks: TASKS, providers: ['anthropic'] };
  const provider = new RecordedModelProvider('anthropic', [{ modelId: 'claude-opus-5', result }], (m) => aiCatalogCapabilities('anthropic', m));
  const gateway = new AiRuntimeGateway(
    { activation, policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
    { providers: [provider], ledger, authorize: async () => true, now: () => NOW, newInvocationId: () => `inv_${Math.random().toString(36).slice(2)}`, providerPolicies: async () => POLICY },
  );
  return { reader: new DomainReadingService(gateway), ledger };
}

const calendarFacts = {
  calendarTimeZone: async () => 'UTC',
  calendarEvents: async () => [{ id: 'ev1', summary: 'Premier review', startsAt: new Date('2026-09-28T15:00:00Z'), endsAt: new Date('2026-09-28T16:00:00Z'), status: 'confirmed', externalAttendeeCount: 2, attendeeHashes: ['h1'], selfResponse: 'accepted' }],
  waitingThreadParticipants: async () => [],
  sentMailTo: async () => true,
  connectedGooglePrincipals: async () => [],
} as never;

test('Calendar: an activated calendar.domain.reading reaches the provider and is recorded in the ledger (BACKGROUND); the digest is RULE_AND_MODEL', async () => {
  const { reader, ledger } = runtime(reading('A client review this afternoon matters most today.', 'work_event:ev1'));
  const p = calendarDomainProducer(calendarFacts, { modelEnabled: (id) => TASKS.includes(id), reader, principalFor: async (t) => (t.scope === 'PRINCIPAL' ? { organizationId: t.organizationId, userId: t.userId } : null) });
  const target = { scope: 'PRINCIPAL', organizationId: ORG, userId: USER, domain: 'CALENDAR', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;
  const g = await p.gather(target, NOW);
  assert.equal(g.status, 'READY');
  const r = await p.read(target, (g as { context: never }).context, 'calendar:fp', NOW);
  assert.equal(r.status, 'READ');
  const digest = (r as { digest: { provenance: { producerKind: string }; content: { reading: { statement: string } } } }).digest;
  assert.equal(digest.provenance.producerKind, 'RULE_AND_MODEL', `model stage outcome: ${(r as { modelStage?: string }).modelStage}`);
  assert.equal(digest.content.reading.statement, 'A client review this afternoon matters most today.');
  assert.equal(ledger.calls.length, 1, 'one ledger reservation');
  assert.equal(ledger.calls[0]!.taskId, 'calendar.domain.reading');
  assert.equal(ledger.calls[0]!.lane, 'BACKGROUND');
});

test('CallGrid: an organization reading via the acting operator reaches the provider; RULE_AND_MODEL', async () => {
  const { reader, ledger } = runtime(reading('Calls held steady this week.', 'marketplace_calls:7d'));
  const dim = { key: 'c1', label: 'c1', calls: 40, monetized: 30, converted: 0, revenueCents: 400000, payoutCents: 200000, costCents: 0, callsWithRevenue: 40, callsWithPayout: 40, callsWithCost: 0 };
  const agg = { calls: 40, monetized: 30, converted: 0, revenueCents: 400000, payoutCents: 200000, costCents: 0, callsWithRevenue: 40, callsWithPayout: 40, callsWithCost: 0, buyers: [dim], vendors: [], sources: [], campaigns: [dim] };
  const calls = { firstCallAt: async () => new Date('2026-01-01'), aggregateWindow: async () => agg, organizationIdsWithCallsSince: async () => [] };
  const p = callgridDomainProducer(calls as never, { modelEnabled: (id) => TASKS.includes(id), reader, principalFor: async () => ({ organizationId: ORG, userId: OPERATOR }) });
  const target = { scope: 'ORGANIZATION', organizationId: ORG, domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;
  const g = await p.gather(target, NOW);
  const r = await p.read(target, (g as { context: never }).context, 'callgrid:fp', NOW);
  const digest = (r as { digest: { provenance: { producerKind: string } } }).digest;
  assert.equal(digest.provenance.producerKind, 'RULE_AND_MODEL', `model stage outcome: ${(r as { modelStage?: string }).modelStage}`);
  assert.equal(ledger.calls.length, 1);
  assert.equal(ledger.calls[0]!.lane, 'BACKGROUND');
});

test('the root cause, pinned: a domain context whose blocks are not minted inside the organization is refused by the gateway before any reservation', async () => {
  const { validateAiContextPackage } = await import('@emgloop/shared');
  const item = { blockId: 'work_event:ev1', kind: 'STRUCTURED', trust: 'UNTRUSTED_INPUT', sourceRef: 'work_event:ev1', content: '{}', sensitivity: 'COMMUNICATION_CONTENT', readUnder: { resource: 'employeeIntelligence', action: 'view' } } as const;
  const pkg = { organizationId: ORG, viewerUserId: USER, taskId: 'calendar.domain.reading', items: [item], sensitivityCeiling: 'COMMUNICATION_CONTENT' } as const;
  assert.deepEqual(validateAiContextPackage(pkg), ['CROSS_ORGANIZATION_BLOCK'], 'what production hit on every domain model stage');
  assert.deepEqual(validateAiContextPackage({ ...pkg, items: [{ ...item, blockId: `${ORG}::work_event:ev1` }] }), []);
});

test('model-stage codes are bounded and content-free: refusal codes pass through, anything else becomes OTHER', async () => {
  const { modelStageCode } = await import('../src/services/intelligence-fabric/domain-kit');
  assert.equal(modelStageCode({ outcome: 'READ' }), 'MODEL_READ');
  assert.equal(modelStageCode({ outcome: 'REFUSED_BY_LOOP', codes: ['TASK_NOT_ENABLED', 'ORGANIZATION_NOT_ENABLED', 'TASK_NOT_ENABLED'] }), 'REFUSED_BY_LOOP:ORGANIZATION_NOT_ENABLED+TASK_NOT_ENABLED');
  assert.equal(modelStageCode({ outcome: 'CONTEXT_REFUSED', codes: ['CROSS_ORGANIZATION_BLOCK'] }), 'CONTEXT_REFUSED:CROSS_ORGANIZATION_BLOCK');
  assert.equal(modelStageCode({ outcome: 'FAILED', failure: 'TIMEOUT' }), 'FAILED:TIMEOUT');
  assert.equal(modelStageCode({ outcome: 'FAILED', failure: 'org demo-org-0001 said: secret text' }), 'FAILED:OTHER', 'provider text never becomes a code');
  assert.equal(modelStageCode({ outcome: 'REFUSED_BY_LOOP', codes: ['user_abc123'] }), 'REFUSED_BY_LOOP:OTHER');
  assert.equal(modelStageCode({ outcome: 'REJECTED_OUTPUT', codes: ['UNCITED_CLAIM'] }), 'REJECTED_OUTPUT:UNCITED_CLAIM', 'which rules the answer broke, codes only');
});

test('situation and Briefing contexts are minted inside the organization too (both still OFF in production)', async () => {
  const { validateAiContextPackage } = await import('@emgloop/shared');
  const { situationContext } = await import('../src/services/intelligence-fabric/situations');
  const signal = { key: 'k', kind: 'RISK', knowledge: 'OBSERVED', statement: 'x', entities: ['campaign:c1'], evidenceRefs: ['x:y'] } as const;
  const cluster = { clusterBasis: 'campaign:c1', fingerprintBasis: '[]', items: [{ ref: 'digest:d1/k', domain: 'CALLGRID', signal, at: NOW.getTime() }], refs: ['campaign:c1'], domains: ['CALLGRID', 'CAMPAIGNS'], windowStart: NOW.getTime(), windowEnd: NOW.getTime() };
  const { items } = situationContext(cluster as never, [], 'ORGANIZATION', { resource: 'intelligence', action: 'view' }, ORG);
  assert.deepEqual(validateAiContextPackage({ organizationId: ORG, viewerUserId: OPERATOR, taskId: 'situation.synthesis', items, sensitivityCeiling: 'OPERATIONAL' }), []);
  const briefing = readFileSync(join(__dirname, '..', 'src', 'services', 'intelligence-fabric', 'briefing.ts'), 'utf8');
  assert.match(briefing, /blockId: `\$\{organizationId\}::a\$\{i\}`/);
});
