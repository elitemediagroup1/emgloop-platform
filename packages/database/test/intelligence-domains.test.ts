// Loop Intelligence Phase E: the domain producers, the assembly, the acting principal and the pass.
// In-memory: rule readings over fixed facts, and the kit's model gating with a recording reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestContentRefusals, entityRefRefusal, INTELLIGENCE_DOMAIN_REGISTRY } from '@emgloop/shared';

import { INTELLIGENCE_PRODUCER_CATALOG } from '../src/services/intelligence-fabric/catalog';
import { calendarDomainProducer } from '../src/services/intelligence-fabric/domains/calendar';
import { callgridRule, campaignsRule, callgridDomainProducer } from '../src/services/intelligence-fabric/domains/callgrid';
import { creatorsRule, crmRule, pipelineRule, websiteRule, workRule, websiteDomainProducer, type WebsiteEvidenceReader } from '../src/services/intelligence-fabric/domains/records';
import { comparableChange } from '../src/services/intelligence-fabric/domains/organization-kit';
import { trimQuotedHistory } from '../src/services/intelligence-fabric/domains/mail-read-through';
import { loopProducers, parseActingUsers, principalResolver } from '../src/services/intelligence-fabric/loop-producers';
import { IntelligenceProducerRegistry } from '../src/services/intelligence-fabric/producer';
import { runIntelligencePass } from '../src/services/intelligence-fabric/intelligence-pass';
import type { RuleReading } from '../src/services/intelligence-fabric/domain-kit';

const NOW = new Date('2026-09-26T12:00:00Z');

const dim = (key: string, calls: number, monetized: number, revenueCents: number) => ({ key, label: key, calls, monetized, converted: 0, revenueCents, payoutCents: Math.round(revenueCents / 2), costCents: 0, callsWithRevenue: calls, callsWithPayout: calls, callsWithCost: 0 });
const agg = (campaigns: ReturnType<typeof dim>[], buyers: ReturnType<typeof dim>[] = campaigns) => {
  const sum = (k: 'calls' | 'monetized' | 'revenueCents' | 'payoutCents') => campaigns.reduce((n, c) => n + c[k], 0);
  return { calls: sum('calls'), monetized: sum('monetized'), converted: 0, revenueCents: sum('revenueCents'), payoutCents: sum('payoutCents'), costCents: 0, callsWithRevenue: sum('calls'), callsWithPayout: sum('calls'), callsWithCost: 0, buyers, vendors: [], sources: [], campaigns };
};

/** Every rule reading must be writable as ORGANIZATION content and name only organization references. */
function assertWritable(rule: RuleReading) {
  const content = { synthesis: rule.statement, confidence: rule.confidence, limitations: rule.limitations, reading: { statement: rule.statement, status: rule.status, confidence: rule.confidence }, signals: rule.signals };
  assert.deepEqual(digestContentRefusals(content, { scope: 'ORGANIZATION', producerKind: 'RULE' }), [], rule.statement);
  for (const r of rule.entityRefs) assert.equal(entityRefRefusal(r, 'ORGANIZATION'), null, r);
  for (const s of rule.signals) if (s.knowledge === 'MEASURED') assert.ok(s.metric, `${s.key} measures a metric`);
  // The repository refuses evidence with no instant: counts are evidence as of the read.
  if (rule.evidenceCount > 0) assert.ok(rule.lastEvidenceAt, 'evidence carries its instant');
}

test('comparable windows: no prior activity or too little is no percentage, never a fabricated change', () => {
  assert.equal(comparableChange(10, 0), null);
  assert.equal(comparableChange(2, 3), null);
  assert.equal(comparableChange(60, 100), -40);
});

test('CallGrid rule: MEASURED calls and revenue, an OBSERVED drop against the COMPARABLE week, buyer concentration; writable as org content', () => {
  const current = agg([dim('c1', 40, 30, 400_000)], [dim('b1', 35, 28, 380_000), dim('b2', 5, 2, 20_000)]);
  const prior = agg([dim('c1', 100, 70, 900_000)]);
  const r = callgridRule({ current, prior, lastDayCalls: 3, windowStart: new Date(NOW.getTime() - 7 * 864e5), windowEnd: NOW }, NOW);
  assertWritable(r);
  assert.equal(r.status, 'ATTENTION');
  assert.ok(r.signals.some((s) => s.key === 'calls' && s.knowledge === 'MEASURED' && s.metric?.value === 40));
  assert.ok(r.signals.some((s) => s.key === 'calls-change' && s.kind === 'RISK' && /down 60%/.test(s.statement)));
  assert.ok(r.signals.some((s) => s.key === 'buyer-concentration'));
  assert.ok(r.entityRefs.every((e) => e.startsWith('provider_member:callgrid:buyer:')));
});

test('CallGrid rule: when the record does not cover the prior window there is no comparison, and the reading says so', () => {
  const r = callgridRule({ current: agg([dim('c1', 40, 30, 400_000)]), prior: null, lastDayCalls: 0, windowStart: NOW, windowEnd: NOW }, NOW);
  assertWritable(r);
  assert.ok(!r.signals.some((s) => s.key.endsWith('-change') || s.key === 'quiet-day'));
  assert.ok(r.limitations.some((l) => /no comparison/.test(l)));
  assert.equal(r.coverage, 'CONNECTED_PARTIAL');
});

test('CallGrid rule: partial revenue is a lower bound, never a total; no margin is claimed', () => {
  const current = { ...agg([dim('c1', 40, 30, 400_000)]), callsWithRevenue: 20 };
  const r = callgridRule({ current, prior: null, lastDayCalls: 1, windowStart: NOW, windowEnd: NOW }, NOW);
  assert.ok(r.signals.find((s) => s.key === 'revenue')!.statement.includes('lower bound'));
  assert.ok(!r.signals.some((s) => s.key === 'margin'));
});

test('Campaigns rule: sharp movers, a campaign gone quiet, and calls nobody bought -- as canonical campaign references', () => {
  const current = agg([dim('grow', 50, 20, 1), dim('unsold', 12, 0, 0)]);
  const prior = agg([dim('grow', 20, 10, 1), dim('gone', 30, 10, 1), dim('unsold', 12, 0, 0)]);
  const r = campaignsRule({ current, prior, lastDayCalls: 5, windowStart: NOW, windowEnd: NOW }, NOW);
  assertWritable(r);
  assert.ok(r.signals.some((s) => s.kind === 'QUIET' && s.entities?.[0] === 'provider_member:callgrid:campaign:gone'));
  assert.ok(r.signals.some((s) => s.kind === 'CHANGE' && s.entities?.[0] === 'provider_member:callgrid:campaign:grow'));
  assert.ok(r.signals.some((s) => s.key.startsWith('unsold.')));
});

test('Intake, People, Creators, Work and Website rules are writable organization content with MEASURED metrics', () => {
  const pipeline = pipelineRule({ counts: { New: 5, Contacted: 3, Quoted: 4, Booked: 2, Completed: 1, Archived: 0 }, week: { newCustomers: 5, conversations: 6, conversationsAssigned: 2 }, prior: { newCustomers: 12 }, stale: { New: 0, Contacted: 1, Quoted: 3 } }, NOW);
  assertWritable(pipeline);
  assert.ok(pipeline.signals.some((s) => s.key === 'stale.quoted' && s.kind === 'STALLED' && s.severity === 'HIGH'));
  assert.ok(pipeline.signals.some((s) => s.key === 'unassigned-conversations'));
  const crm = crmRule({ people: 40, companies: 10, awaiting: 30, newEstablished: 2, priorEstablished: 10, active: 12, started: 1, ended: 3 }, NOW);
  assertWritable(crm);
  assert.ok(crm.signals.some((s) => s.kind === 'DECISION_PENDING'));
  const creators = creatorsRule({ creators: 3, needsEmg: 2, needsCreator: 1, inProduction: 4, dueSoon: 1, waitingOnEmg: ['creator:p1'] }, NOW);
  assertWritable(creators);
  assert.ok(creators.signals.some((s) => s.kind === 'OBLIGATION' && s.owedBy === 'VIEWER'));
  const work = workRule({ activeInstances: 5, openStages: 9, unassigned: 2, overdue: 1, dueSoon: 2, pastReturn: 1, completed7d: 4, completedPrior7d: 10, overdueInstanceIds: ['w1'], personal: false }, NOW);
  assertWritable(work);
  assert.equal(work.status, 'ATTENTION');
  const mine = workRule({ activeInstances: 2, openStages: 3, unassigned: 0, overdue: 1, dueSoon: 0, pastReturn: 0, completed7d: 0, completedPrior7d: 0, overdueInstanceIds: ['w1'], personal: true }, NOW);
  assert.ok(mine.signals.some((s) => s.key === 'overdue' && s.kind === 'OBLIGATION' && s.owedBy === 'VIEWER'));
  assert.ok(!mine.signals.some((s) => s.key === 'unassigned'), 'a person is never told about the org-wide unowned queue');
  const website = websiteRule({ bySource: [{ sourceId: 'WEBSITE_EVENTS', week: { sessions: 120, formSubmits: 3, appointmentRequests: 1 }, prior: { sessions: 200, formSubmits: 3, appointmentRequests: 1 } }] }, NOW);
  assertWritable(website);
  assert.ok(website.signals.some((s) => s.key === 'website_events.sessions-change' && s.kind === 'RISK'));
});

test('Website is source-ready: a second connected source is read beside website events, and the reading names both sources', async () => {
  const reader = (sourceId: string, sessions: number): WebsiteEvidenceReader => ({ sourceId, read: async () => ({ sessions }) });
  const producer = websiteDomainProducer([reader('WEBSITE_EVENTS', 10), reader('SEARCH_CONSOLE_FUTURE', 50)], { organizationsWithWebsiteEvents: async () => [] } as never, { modelEnabled: () => false, reader: null, principalFor: async () => null });
  const g = await producer.gather({ scope: 'ORGANIZATION', organizationId: 'o', domain: 'WEBSITE', subjectKind: 'DOMAIN', subjectRef: 'domain' }, NOW);
  assert.equal(g.status, 'READY');
  const read = await producer.read({ scope: 'ORGANIZATION', organizationId: 'o', domain: 'WEBSITE', subjectKind: 'DOMAIN', subjectRef: 'domain' }, (g as { context: never }).context, 'fp', NOW);
  assert.equal(read.status, 'READ');
  const sources = (read as { digest: { provenance: { sources: { sourceId: string }[] } } }).digest.provenance.sources.map((s) => s.sourceId);
  assert.deepEqual(sources, ['WEBSITE_EVENTS', 'SEARCH_CONSOLE_FUTURE']);
});

test('the model stage: not activated = no call; activated without an acting principal = no call; activated with one = merged, rule MEASURED kept', async () => {
  const calls = { firstCallAt: async () => new Date('2026-01-01'), aggregateWindow: async () => agg([dim('c1', 40, 30, 400_000)]), organizationIdsWithCallsSince: async () => [] };
  const target = { scope: 'ORGANIZATION', organizationId: 'org1', domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;
  const asked: unknown[] = [];
  const reader = {
    read: async (principal: unknown, req: { context: { items: unknown[] } }) => {
      asked.push({ principal, items: req.context.items.length });
      return { outcome: 'READ', reading: { reading: { statement: 'Calls are steady.', status: 'CALM', confidence: 'MEDIUM' }, signals: [{ key: 'steady', kind: 'OPERATIONAL', knowledge: 'INFERRED', statement: 'Steady.', evidenceRefs: ['marketplace_calls:7d'] }], limitations: [] }, provenance: { invocationId: 'inv1', taskVersion: '1.0.0' } };
    },
  } as never;
  const run = async (enabled: boolean, principal: { organizationId: string; userId: string } | null) => {
    const p = callgridDomainProducer(calls, { modelEnabled: () => enabled, reader, principalFor: async () => principal });
    const g = await p.gather(target, NOW);
    return p.read(target, (g as { context: never }).context, 'fp', NOW);
  };
  const off = await run(false, { organizationId: 'org1', userId: 'u1' });
  assert.equal(asked.length, 0);
  assert.equal((off as { digest: { provenance: { producerKind: string } } }).digest.provenance.producerKind, 'RULE');
  await run(true, null);
  assert.equal(asked.length, 0, 'no acting principal, no call');
  const on = await run(true, { organizationId: 'org1', userId: 'u1' });
  assert.equal(asked.length, 1);
  const digest = (on as { digest: { content: { signals: { key: string; knowledge: string }[]; reading: { statement: string } }; provenance: { producerKind: string } } }).digest;
  assert.equal(digest.provenance.producerKind, 'RULE_AND_MODEL');
  assert.equal(digest.content.reading.statement, 'Calls are steady.');
  assert.ok(digest.content.signals.some((s) => s.key === 'calls' && s.knowledge === 'MEASURED'));
  assert.ok(digest.content.signals.some((s) => s.key === 'm.steady' && s.knowledge === 'INFERRED'));
});

test('acting principal: only a NAMED user who is an ACTIVE operator member of that organization; malformed pairs dropped', async () => {
  const acting = parseActingUsers('orgA=userA, orgB = userB ,bad,=x,orgC=u=v');
  assert.deepEqual([...acting.entries()], [['orgA', 'userA'], ['orgB', 'userB']]);
  const facts = { actingOperator: async (org: string, user: string) => (org === 'orgA' && user === 'userA' ? { organizationId: org, userId: user, role: 'ADMIN' } : null) };
  const resolve = principalResolver(facts, acting, () => NOW);
  assert.deepEqual(await resolve({ scope: 'ORGANIZATION', organizationId: 'orgA', domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'domain' }), { organizationId: 'orgA', userId: 'userA' });
  assert.equal(await resolve({ scope: 'ORGANIZATION', organizationId: 'orgB', domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'domain' }), null, 'named but not a qualifying member');
  assert.equal(await resolve({ scope: 'ORGANIZATION', organizationId: 'orgZ', domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'domain' }), null, 'not named');
  assert.deepEqual(await resolve({ scope: 'PRINCIPAL', organizationId: 'orgZ', userId: 'me', domain: 'CALENDAR', subjectKind: 'DOMAIN', subjectRef: 'domain' }), { organizationId: 'orgZ', userId: 'me' });
});

test('assembly: the catalog is exactly what loopProducers builds (with Mail), every producer has one domain registry entry, and each model task matches the registry', () => {
  const producers = loopProducers({ prisma: {} as never, work: {} as never, reader: null, modelEnabled: () => false, actingUsers: new Map(), now: () => NOW, mail: { governanceDecision: null, readThread: async () => null, triage: null } });
  assert.deepEqual(producers.map((p) => ({ id: p.id, domain: p.domain, scope: p.scope, subjectKinds: [...p.subjectKinds], kind: p.kind, taskId: p.taskId })), INTELLIGENCE_PRODUCER_CATALOG.map((d) => ({ ...d, subjectKinds: [...d.subjectKinds] })));
  for (const p of producers) {
    const entry = INTELLIGENCE_DOMAIN_REGISTRY.find((d) => d.domain === p.domain)!;
    assert.ok(entry.scopes.includes(p.scope), `${p.id} scope is admitted by its domain`);
    if (p.subjectKinds.includes('DOMAIN') && p.taskId) assert.equal(p.taskId, entry.readingTask, `${p.id} reads with its domain's task`);
  }
  // Every producer can be active at once: one per (domain, scope, subject kind).
  new IntelligenceProducerRegistry(producers, producers.map((p) => p.id));
  // Without the Mail ports, the Mail producers are not assembled (the worker hosts the rest).
  const worker = loopProducers({ prisma: {} as never, work: {} as never, reader: null, modelEnabled: () => false, actingUsers: new Map(), now: () => NOW });
  assert.ok(!worker.some((p) => p.domain === 'MAIL'));
});

test('the pass: nothing active discovers, enqueues and claims nothing; an active producer discovers, enqueues SCHEDULED and runs the loop', async () => {
  const log: string[] = [];
  const producer = { id: 'x.domain@1', domain: 'WORK', scope: 'ORGANIZATION', subjectKinds: ['DOMAIN'], kind: 'RULE', taskId: null, discover: async () => { log.push('discover'); return [{ scope: 'ORGANIZATION', organizationId: 'o', domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' }]; }, gather: async () => ({ status: 'NO_EVIDENCE' }), read: async () => ({ status: 'NOT_READ', reason: 'x', retryable: false }) } as never;
  const queue = {
    enqueue: async (_t: unknown, req: { reason: string }) => { log.push(`enqueue:${req.reason}`); return { outcome: 'ENQUEUED', id: '1' }; },
    claim: async () => { log.push('claim'); return []; },
    complete: async () => undefined, retry: async () => undefined, hold: async () => undefined,
  } as never;
  const digests = {} as never;
  const off = await runIntelligencePass({ registry: new IntelligenceProducerRegistry([producer], []), queue, digests, leaseOwner: 't', now: () => NOW }, { limit: 5, leaseMs: 1000, maxAttempts: 3, discoverLimit: 10 });
  assert.equal(off.activeProducers, 0);
  assert.deepEqual(log, []);
  const on = await runIntelligencePass({ registry: new IntelligenceProducerRegistry([producer], ['x.domain@1']), queue, digests, leaseOwner: 't', now: () => NOW }, { limit: 5, leaseMs: 1000, maxAttempts: 3, discoverLimit: 10 });
  assert.equal(on.enqueued, 1);
  assert.deepEqual(log, ['discover', 'enqueue:SCHEDULED', 'claim']);
});

test('Mail read-through trims quoted history and caps the text', () => {
  assert.equal(trimQuotedHistory('Thanks, see below.\n\nOn Tue, Sep 22, 2026 at 9:00 AM Someone wrote:\n> old text\n> more'), 'Thanks, see below.');
  assert.equal(trimQuotedHistory('a\n> quoted\nb'), 'a\nb');
  assert.equal(trimQuotedHistory('x'.repeat(5000)).length, 4000);
});

test('Calendar: the person’s own day -- overlaps, a meeting with someone whose mail waits on them, and no follow-up after an outside meeting', async () => {
  const h = (hours: number) => new Date(NOW.getTime() + hours * 3600_000);
  const ev = (id: string, from: number, to: number, attendees: string[], external = 0) => ({ id, summary: `Meeting ${id}`, startsAt: h(from), endsAt: h(to), status: 'confirmed', externalAttendeeCount: external, attendeeHashes: attendees, selfResponse: 'accepted' });
  const seen: string[] = [];
  const facts = {
    calendarTimeZone: async () => 'UTC',
    calendarEvents: async (org: string, user: string) => { seen.push(`${org}/${user}`); return [ev('past', -3, -2, ['x'], 1), ev('a', 1, 2, ['p']), ev('b', 1.5, 3, []), ev('c', 4, 5, ['q'])]; },
    waitingThreadParticipants: async () => [['q', 'z']],
    sentMailTo: async () => false,
    connectedGooglePrincipals: async () => [],
  } as never;
  const p = calendarDomainProducer(facts, { modelEnabled: () => false, reader: null, principalFor: async () => null });
  const target = { scope: 'PRINCIPAL', organizationId: 'o1', userId: 'u1', domain: 'CALENDAR', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;
  const g = await p.gather(target, NOW);
  assert.equal(g.status, 'READY');
  assert.deepEqual(seen, ['o1/u1'], 'read as that person only');
  const r = await p.read(target, (g as { context: never }).context, 'fp', NOW);
  const signals = (r as { digest: { content: { signals: { key: string; kind: string }[] } } }).digest.content.signals;
  assert.ok(signals.some((s) => s.key.startsWith('conflict.') && s.kind === 'RISK'));
  assert.ok(signals.some((s) => s.key.startsWith('prep.') && s.kind === 'ATTENTION'));
  assert.ok(signals.some((s) => s.key.startsWith('follow-up.')));
  assert.equal((await p.gather({ scope: 'ORGANIZATION', organizationId: 'o1', domain: 'CALENDAR', subjectKind: 'DOMAIN', subjectRef: 'domain' } as never, NOW)).status, 'NOT_PERMITTED');
});
