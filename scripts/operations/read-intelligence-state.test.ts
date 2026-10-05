// Read Intelligence State: a read-only diagnosis that prints ids, rules, states, times and counts --
// never a title, a name, an entity, an address, a key or a message -- and cannot write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  CALLGRID_CASE_PRODUCER,
  IamRepository,
  IntelligenceStateRepository,
  WorkGraphRepository,
  readOnlyClient,
  type IntelligenceState,
} from '@emgloop/database';
import { makeCognitivePrisma } from '../../packages/database/test/helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../../packages/database/src/services/decision/decision-engine';
import { DEFAULT_LOOKBACK_HOURS, MAX_LOOKBACK_DAYS, parseArgs, readEnvironment, resolveSince, runIntelligenceState, token } from './read-intelligence-state';
import { employeeRef } from './cycle-employee-sources';

const NOW = new Date('2026-09-19T19:00:00Z');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

/** A real reader over the test double, seeded with everything this runner must never print. */
async function world() {
  const fake: any = makeCognitivePrisma({ also: ['organization', 'invitation', 'organizationMembership', 'crmRelationship', 'crmRelationshipEvent', 'crmParticipant', 'intelligenceRefreshRequest'] });
  const prisma = fake as PrismaClient;
  await fake.organization.create({ data: { id: 'org_live_1', name: 'Services In My City', slug: 'servicesinmycity-demo' } });
  const iam = new IamRepository(prisma);
  const matt = await iam.createUser({ organizationId: 'org_live_1', email: 'matt@elitemediagroup.example', name: 'Matt', systemRole: 'OWNER' });
  await iam.activateUser('org_live_1', matt.id);
  const engine = new DecisionEngine(prisma);
  const at = new Date('2026-09-19T18:25:10Z');
  const created = await engine.create('org_live_1', {
    producer: CALLGRID_CASE_PRODUCER,
    recurrenceKey: 'revenue-concentration::Acme Insurance Group',
    detectionKey: 'daily:2026-09-19',
    detectedAt: at,
    title: 'Acme Insurance Group is 60% of revenue',
    summary: 'Acme Insurance Group dominates',
    severity: 'HIGH',
    evidence: [{ source: 'summary-report', metricKey: 'revenue', window: 'day', ruleId: 'revenue-concentration', ruleVersion: 'v1', observedAt: at, entityType: 'buyer', entityId: 'buyer-7781', entityName: 'Acme Insurance Group' }],
  } as never);
  // The double stamps rows from its own clock; a database stamps them when the detector wrote them.
  for (const row of [...fake.operationalPriority.__rows, ...fake.operationalObservation.__rows, ...fake.decisionEvidence.__rows]) {
    row.createdAt = at;
    if ('recordedAt' in row) row.recordedAt = at;
  }
  await fake.workDraft.create({ data: { organizationId: 'org_live_1', userId: matt.id, provider: 'GOOGLE', threadId: 't', inReplyToMessageId: 'm', mode: 'REPLY', body: 'Please call me', toAddresses: ['dana@acme.test'] } });
  await new WorkGraphRepository(prisma).upsertEvent({ organizationId: 'org_live_1', userId: matt.id }, {
    provider: 'GOOGLE', eventId: 'e1', startsAt: at, endsAt: at, summary: 'Renewal with Dana', status: 'CONFIRMED', attendanceKnown: true, attendeeCount: 2,
    attendeeHashes: [hash('dana@acme.test')], observedAt: at,
  });
  const out: string[] = [];
  const reader = new IntelligenceStateRepository(readOnlyClient(prisma));
  return { fake, matt, caseId: created.decision.id, out, deps: { reader, now: () => NOW, log: (l: string) => void out.push(l) } };
}

const SENSITIVE = [
  'Acme Insurance Group',
  'buyer-7781',
  'Please call me',
  'dana@acme.test',
  'Renewal with Dana',
  hash('dana@acme.test'),
  'matt@elitemediagroup.example',
  'Services In My City',
];

test('flags, environment and the moment to read from', () => {
  assert.deepEqual(parseArgs(['--organization', '  servicesinmycity-demo ', '--since', ' 2026-09-19T18:00:00Z ']), { organization: 'servicesinmycity-demo', since: '2026-09-19T18:00:00Z' });
  assert.deepEqual(parseArgs(['--org', 'acme', '--since', '']), { organization: 'acme', since: '' });
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
  const fallback = resolveSince('', NOW);
  assert.ok(fallback.ok && fallback.since.getTime() === NOW.getTime() - DEFAULT_LOOKBACK_HOURS * 3_600_000, 'empty means the last day');
  assert.ok(resolveSince('2026-09-19T18:00:00Z', NOW).ok);
  assert.ok(resolveSince('2026-09-19T18:00Z', NOW).ok);
  for (const bad of ['yesterday', '2026-09-19', '2026-09-19T18:00:00+02:00', '2026-09-19 18:00:00Z', '2026-09-20T18:00:00Z', '2026-02-30T00:00:00Z']) {
    assert.equal(resolveSince(bad, NOW).ok, false, `${bad} is refused`);
  }
  assert.equal(resolveSince(new Date(NOW.getTime() - (MAX_LOOKBACK_DAYS + 1) * 86_400_000).toISOString(), NOW).ok, false, 'no further back than the bound');
});

test('a malformed or unknown organization, or a bad moment, is refused before anything is read', async () => {
  const w = await world();
  let reads = 0;
  const reader = { organizationBySlug: w.deps.reader.organizationBySlug.bind(w.deps.reader), read: async () => ((reads += 1), ({} as IntelligenceState)) };
  for (const [slug, since] of [['Services In My City', ''], ['no-such-org', ''], ['servicesinmycity-demo', 'yesterday'], ['servicesinmycity-demo', '2026-09-20T00:00:00Z']] as const) {
    const out: string[] = [];
    const result = await runIntelligenceState({ organizationSlug: slug, since }, { reader, now: () => NOW, log: (l) => void out.push(l) });
    assert.equal(result.overall, 'FAILED_PRECONDITION');
    assert.match(out.join('\n'), /^event=PRECONDITION_FAILED /);
  }
  assert.equal(reads, 0, 'nothing was read');
});

test('every section is printed, with exactly these fields', async () => {
  const w = await world();
  const result = await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '2026-09-19T00:00:00Z' }, w.deps);
  assert.equal(result.overall, 'READ');
  const events = w.out.map((l) => /^event=(\S+)/.exec(l)?.[1]);
  for (const section of ['ORGANIZATION', 'CASES', 'CASE_LOG_SINCE_SUMMARY', 'DUPLICATES', 'WRITES', 'OUTBOX_SUMMARY', 'CREATOR', 'DELIVERY_SUMMARY', 'INTELLIGENCE_REFRESH_SUMMARY', 'SUMMARY']) {
    assert.ok(events.includes(section), `${section} is printed`);
  }
  const fields = (event: string) => (w.out.find((l) => l.startsWith(`event=${event} `)) ?? '').split(' ').map((kv) => kv.slice(0, kv.indexOf('=')));
  assert.deepEqual(fields('ORGANIZATION'), ['event', 'organization', 'since', 'at']);
  assert.deepEqual(fields('WRITES'), ['event', 'since', 'casesCreated', 'casesUpdated', 'caseLog', 'caseEvidence', 'hypotheses', 'outbox', 'deliveries', 'draftsCreated', 'draftsSent', 'crmRelationships', 'crmParticipants']);
  assert.deepEqual(fields('EMPLOYEE'), [
    'event', 'ref', 'membership', 'role', 'events', 'attendanceKnown', 'eventsWithAttendeeKeys', 'attendeeKeys', 'latestKeyedEventObservedAt',
    'suggestionsProposed', 'suggestionsConfirmed', 'suggestionsRejected', 'suggestionsOther',
  ]);
  // The Case the detector recorded, and its one sighting, by id, rule, type and time.
  const caseLine = w.out.find((l) => l.startsWith('event=CASE '))!;
  assert.match(caseLine, new RegExp(`^event=CASE id=${w.caseId} rule=revenue-concentration entityType=buyer state=NEEDS_REVIEW severity=HIGH outcome=- createdAt=2026-09-19T18:25:10.000Z firstSeen=2026-09-19T18:25:10.000Z lastSeen=2026-09-19T18:25:10.000Z timesSeen=1 reopened=0 hypothesis=false logEntries=1 humanActs=0 scope=OK$`));
  assert.ok(w.out.includes(`event=SIGHTING case=${w.caseId} type=SITUATION_DETECTED actor=SYSTEM source=CALLGRID occurredAt=2026-09-19T18:25:10.000Z recordedAt=2026-09-19T18:25:10.000Z detectionKey=daily:2026-09-19`));
  // The member, as the cycle's ref, with counts.
  assert.ok(w.out.includes(`event=EMPLOYEE ref=${employeeRef({ organizationId: 'org_live_1', userId: w.matt.id })} membership=ACTIVE role=OWNER events=1 attendanceKnown=1 eventsWithAttendeeKeys=1 attendeeKeys=1 latestKeyedEventObservedAt=2026-09-19T18:25:10.000Z suggestionsProposed=0 suggestionsConfirmed=0 suggestionsRejected=0 suggestionsOther=0`));
});

test('nothing private or identifying is printed: no title, name, entity, address, key, message, user or organization id', async () => {
  const w = await world();
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '2026-09-19T00:00:00Z' }, w.deps);
  const text = w.out.join('\n');
  for (const secret of [...SENSITIVE, w.matt.id, 'org_live_1', '@']) assert.equal(text.includes(secret), false, `${secret} must not be printed`);
});

/** Refresh requests carrying every private column the queue has, plus one in another organization. */
async function seedRefreshQueue(fake: any, userId: string) {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 28, 10, m));
  const row = (patch: Record<string, unknown>) =>
    fake.intelligenceRefreshRequest.create({
      data: {
        organizationId: 'org_live_1', scope: 'ORGANIZATION', userId: null, domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'campaign:Acme Insurance Group',
        reason: 'EVIDENCE_CHANGED', sourceId: 'buyer-7781', sourceRevision: 'rev-Renewal with Dana', fingerprint: 'campaigns:fp-secret-4f1c', requestCount: 3,
        firstRequestedAt: at(0), lastRequestedAt: at(5), notBefore: at(5), state: 'HELD', attempts: 3, leaseOwner: 'worker-lease-9', leaseExpiresAt: null,
        lastOutcome: 'FINGERPRINT_MISMATCH', createdAt: at(0), updatedAt: at(5),
        ...patch,
      },
    });
  await row({});
  await row({ createdAt: at(2), updatedAt: at(9), subjectRef: 'campaign:Glow Cosmetics' });
  await row({ scope: 'PRINCIPAL', userId, domain: 'CALENDAR', state: 'PENDING', attempts: 1, lastOutcome: null, subjectRef: 'domain', createdAt: at(20), updatedAt: at(21) });
  await row({ organizationId: 'org_other_9', domain: 'PIPELINE', lastOutcome: 'NOT_PERMITTED', subjectRef: 'other-tenant-subject' });
}

test('the refresh queue: identical requests aggregated with their HELD reason, only in the requested organization', async () => {
  const w = await world();
  await seedRefreshQueue(w.fake, w.matt.id);
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '2026-09-19T00:00:00Z' }, w.deps);
  const refresh = w.out.filter((l) => l.startsWith('event=INTELLIGENCE_REFRESH'));
  assert.deepEqual(refresh, [
    'event=INTELLIGENCE_REFRESH domain=CAMPAIGNS scope=ORGANIZATION state=HELD attempts=3 reason=FINGERPRINT_MISMATCH count=2 oldestCreatedAt=2026-09-28T10:00:00.000Z latestUpdatedAt=2026-09-28T10:09:00.000Z',
    'event=INTELLIGENCE_REFRESH domain=CALENDAR scope=PRINCIPAL state=PENDING attempts=1 reason=- count=1 oldestCreatedAt=2026-09-28T10:20:00.000Z latestUpdatedAt=2026-09-28T10:21:00.000Z',
    'event=INTELLIGENCE_REFRESH_SUMMARY present=true requests=3 held=2 bounded=false',
  ]);
});

test('the refresh queue never prints a user id, organization id, subject ref, source id, revision, fingerprint or lease', async () => {
  const w = await world();
  await seedRefreshQueue(w.fake, w.matt.id);
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '2026-09-19T00:00:00Z' }, w.deps);
  const text = w.out.join('\n');
  for (const secret of [w.matt.id, 'org_live_1', 'org_other_9', 'Acme Insurance Group', 'Glow Cosmetics', 'other-tenant-subject', 'buyer-7781', 'Renewal with Dana', 'fp-secret', 'worker-lease-9', 'EVIDENCE_CHANGED', 'NOT_PERMITTED', 'PIPELINE']) {
    assert.equal(text.includes(secret), false, `${secret} must not be printed`);
  }
  // An outcome code that is not a code token prints as UNRECOGNIZED, never as itself.
  const x = await world();
  await x.fake.intelligenceRefreshRequest.create({ data: { organizationId: 'org_live_1', scope: 'ORGANIZATION', domain: 'CAMPAIGNS', subjectKind: 'DOMAIN', subjectRef: 'domain', reason: 'X', requestCount: 1, firstRequestedAt: NOW, lastRequestedAt: NOW, notBefore: NOW, state: 'HELD', attempts: 1, lastOutcome: 'held because Acme Insurance Group said so', createdAt: NOW, updatedAt: NOW } });
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '2026-09-19T00:00:00Z' }, x.deps);
  assert.ok(x.out.some((l) => l.includes('reason=UNRECOGNIZED count=1')));
  assert.equal(x.out.join('\n').includes('Acme'), false);
});

test('the refresh queue read selects only metadata columns, and before its migration says so', async () => {
  const reader = readFileSync(join(__dirname, '..', '..', 'packages', 'database', 'src', 'repositories', 'intelligence-state.repository.ts'), 'utf8');
  const select = /intelligenceRefreshRequest\.findMany\(\{[\s\S]*?select: \{([^}]*)\}/.exec(reader)?.[1] ?? '';
  assert.deepEqual(select.split(',').map((s) => s.trim().replace(/: true$/, '')).filter(Boolean), ['domain', 'scope', 'state', 'attempts', 'lastOutcome', 'createdAt', 'updatedAt']);
  // A database without the queue (a client generated before it): the section says absent, nothing else.
  const fake: any = makeCognitivePrisma({ also: ['organization', 'invitation', 'organizationMembership', 'crmRelationship', 'crmRelationshipEvent', 'crmParticipant'] });
  await fake.organization.create({ data: { id: 'org_live_1', name: 'Services In My City', slug: 'servicesinmycity-demo' } });
  const out: string[] = [];
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { reader: new IntelligenceStateRepository(readOnlyClient(fake as PrismaClient)), now: () => NOW, log: (l) => void out.push(l) });
  assert.ok(out.includes('event=INTELLIGENCE_REFRESH_SUMMARY present=false'));
});

const DIAGNOSIS = {
  selected: true, digests: 3, eligibleDigests: 3, eligibleDomains: ['CALLGRID', 'CAMPAIGNS', 'PIPELINE'], ineligible: { REFRESH_UNRESOLVED: 1 },
  domains: [
    { domain: 'CALLGRID', digests: 1, eligible: 1, signals: 5, clusterable: 1, entityRefs: 1 },
    { domain: 'CAMPAIGNS', digests: 1, eligible: 1, signals: 4, clusterable: 2, entityRefs: 2 },
  ],
  signals: 9, clusterableSignals: 3, excluded: { kind: { OPERATIONAL: 5 }, noEntity: 1 }, clusterableDomains: ['CALLGRID', 'CAMPAIGNS'],
  entityRefs: 3, explicitLinks: 1, projectedLinks: 2, projection: [{ linkClass: 'CUSTOMER_PARTY', records: 1, links: 1, rejected: {} }], sharedAcrossDomains: 1,
  clusters: 1, sourceIndependentClusters: 0, eliminatedSameSource: 1,
  composition: [{ domains: ['CALLGRID', 'CAMPAIGNS'], sources: ['CALLGRID'], streams: ['CALLS'], count: 1, sourceIndependent: false }],
  unchanged: 0, wouldSynthesize: 0, reason: 'NO_INDEPENDENT_SOURCES',
} as const;

test('the situation pass diagnosis prints counts and codes only, for the requested organization', async () => {
  const w = await world();
  const asked: string[] = [];
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, situations: async (organizationId) => (asked.push(organizationId), DIAGNOSIS as never) });
  assert.deepEqual(asked, ['org_live_1'], 'the resolved organization, never a slug from input');
  assert.deepEqual(w.out.filter((l) => l.startsWith('event=SITUATION_')), [
    'event=SITUATION_DOMAIN domain=CALLGRID digests=1 eligible=1 signals=5 clusterable=1 entityRefs=1',
    'event=SITUATION_DOMAIN domain=CAMPAIGNS digests=1 eligible=1 signals=4 clusterable=2 entityRefs=2',
    'event=SITUATION_INELIGIBLE reason=REFRESH_UNRESOLVED count=1',
    'event=SITUATION_EXCLUDED basis=KIND kind=OPERATIONAL count=5',
    'event=SITUATION_EXCLUDED basis=NO_ENTITY kind=- count=1',
    'event=SITUATION_PASS scope=ORGANIZATION selected=true digests=3 eligibleDigests=3 eligibleDomains=CALLGRID,CAMPAIGNS,PIPELINE signals=9 clusterableSignals=3 clusterableDomains=CALLGRID,CAMPAIGNS entityRefs=3 explicitLinks=1 projectedLinks=2 sharedAcrossDomains=1 clusters=1 sourceIndependentClusters=0 eliminatedSameSource=1 unchanged=0 wouldSynthesize=0 reason=NO_INDEPENDENT_SOURCES modelCalls=0',
    'event=SITUATION_PASS_COMPOSITION domains=CALLGRID+CAMPAIGNS sources=CALLGRID streams=CALLS count=1 sourceIndependent=false',
  ]);
  // Absent (a reader without it): the section is simply not printed.
  const x = await world();
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, x.deps);
  assert.equal(x.out.some((l) => l.startsWith('event=SITUATION_')), false);
});

test('the diagnosis cannot leak: a code field carrying text prints UNRECOGNIZED; ids and statements never appear', async () => {
  const w = await world();
  const hostile = { ...DIAGNOSIS, eligibleDomains: ['CALLGRID', 'provider member Acme Insurance Group'], ineligible: { 'org_live_1 said no': 1 }, excluded: { kind: { 'Please call me': 2 }, noEntity: 0 }, composition: [{ domains: ['CAMPAIGNS', 'party p1 Dana'], sources: ['dana@acme.test'], streams: ['jane@acme.test'], count: 1, sourceIndependent: false }], reason: 'Acme Insurance Group' };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, situations: async () => hostile as never });
  const text = w.out.join('\n');
  for (const secret of ['Acme', 'org_live_1', 'Please call me', 'Dana', 'dana@', w.matt.id]) assert.equal(text.includes(secret), false, secret);
  assert.match(text, /eligibleDomains=CALLGRID,UNRECOGNIZED/);
  assert.match(text, /SITUATION_PASS_COMPOSITION domains=CAMPAIGNS\+UNRECOGNIZED sources=UNRECOGNIZED streams=UNRECOGNIZED count=1 sourceIndependent=false/);
  assert.match(text, /reason=UNRECOGNIZED modelCalls=0/);
});

test('production wiring: the diagnosis runs on a read-only client with no runtime and no task enabled -- it cannot call a model', () => {
  const runner = readFileSync(join(__dirname, 'read-intelligence-state.ts'), 'utf8');
  assert.match(runner, /new SituationService\(\{ prisma: readOnlyClient\(prisma\), runtime: null, modelEnabled: \(\) => false, principalFor: async \(\) => null,/);
  assert.match(runner, /situationService\.diagnose\(\{ scope: 'ORGANIZATION', organizationId \}\)/);
  assert.equal(/\.pass\(/.test(runner), false, 'the runner never runs a pass');
  const service = readFileSync(join(__dirname, '..', '..', 'packages', 'database', 'src', 'services', 'intelligence-fabric', 'situations.ts'), 'utf8');
  const diagnose = service.slice(service.indexOf('async diagnose('), service.indexOf('  private async gather('));
  for (const forbidden of ['runtime', 'recordCandidate', '.record(', 'modelEnabled', 'principalFor']) assert.equal(diagnose.includes(forbidden), false, `diagnose never touches ${forbidden}`);
});

const CONNECTIVITY = {
  relationships: [
    { linkClass: 'CUSTOMER_PARTY', records: 2, links: 1, rejected: { PARTY_NOT_ESTABLISHED: 1 } },
    { linkClass: 'CREATOR_PARTY', records: 1, links: 1, rejected: {} },
    { linkClass: 'WORK_ORIGIN', records: 4, links: 1, rejected: { DIGEST_GONE: 1, PRIVATE_SCOPE: 1, CASE_ORIGIN_NOT_CANONICAL: 1 } },
  ],
  relationshipsBounded: false,
  governed: {
    members: [
      { dimension: 'campaign', windowDays: 14, stableExternalId: 6, labelOnly: 2, labelOnlyNamedAsRef: 1, unattributedCalls: 4 },
      { dimension: 'buyer', windowDays: 14, stableExternalId: 3, labelOnly: 0, labelOnlyNamedAsRef: 0, unattributedCalls: 9 },
    ],
    pipeline: { working: 12, stalled: 5, nameable: 5 },
    crm: { established: 40, newlyEstablished7d: 2, nameable: 2, awaitingDecision: 7 },
    bounded: false,
  },
  current: { crossDomain: 1, sourceIndependent: 0, eliminatedSameSource: 1, composition: [{ domains: ['CALLGRID', 'CAMPAIGNS'], sources: ['CALLGRID'], streams: ['CALLS'], count: 1, sourceIndependent: false }] },
  projector: {
    crossDomain: 2, sourceIndependent: 1, eliminatedSameSource: 1,
    composition: [
      { domains: ['CREATORS', 'PIPELINE'], sources: ['LOOP_CREATORS', 'LOOP_INTAKE'], streams: ['CREATOR_RECORDS', 'INTAKE_RECORDS'], count: 1, sourceIndependent: true },
      { domains: ['CALLGRID', 'CAMPAIGNS'], sources: ['CALLGRID'], streams: ['CALLS'], count: 1, sourceIndependent: false },
    ],
  },
} as const;

test('connectivity prints governed relationships, member identity, nameable records and potential components -- counts and codes only', async () => {
  const w = await world();
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, connectivity: async () => CONNECTIVITY as never });
  const lines = w.out.filter((l) => /^event=(SITUATION_(RELATIONSHIP|MEMBERS|NAMEABLE|POTENTIAL|POTENTIAL_GROUP|CONNECTIVITY_SUMMARY)) /.test(l));
  assert.deepEqual(lines, [
    'event=SITUATION_RELATIONSHIP linkClass=CUSTOMER_PARTY records=2 links=1 rejected=PARTY_NOT_ESTABLISHED:1',
    'event=SITUATION_RELATIONSHIP linkClass=CREATOR_PARTY records=1 links=1 rejected=-',
    'event=SITUATION_RELATIONSHIP linkClass=WORK_ORIGIN records=4 links=1 rejected=DIGEST_GONE:1,PRIVATE_SCOPE:1,CASE_ORIGIN_NOT_CANONICAL:1',
    'event=SITUATION_MEMBERS provider=CALLGRID dimension=campaign windowDays=14 stableExternalId=6 labelOnly=2 labelOnlyNamedAsRef=1 unattributedCalls=4',
    'event=SITUATION_MEMBERS provider=CALLGRID dimension=buyer windowDays=14 stableExternalId=3 labelOnly=0 labelOnlyNamedAsRef=0 unattributedCalls=9',
    'event=SITUATION_NAMEABLE domain=PIPELINE kind=customer working=12 stalled=5 nameable=5',
    'event=SITUATION_NAMEABLE domain=CRM kind=party established=40 newlyEstablished7d=2 nameable=2 awaitingDecision=7',
    'event=SITUATION_POTENTIAL_GROUP scenario=CURRENT domains=CALLGRID+CAMPAIGNS sources=CALLGRID streams=CALLS count=1 sourceIndependent=false',
    'event=SITUATION_POTENTIAL scenario=CURRENT crossDomain=1 sourceIndependent=0 eliminatedSameSource=1',
    'event=SITUATION_POTENTIAL_GROUP scenario=PROJECTOR domains=CREATORS+PIPELINE sources=LOOP_CREATORS+LOOP_INTAKE streams=CREATOR_RECORDS+INTAKE_RECORDS count=1 sourceIndependent=true',
    'event=SITUATION_POTENTIAL_GROUP scenario=PROJECTOR domains=CALLGRID+CAMPAIGNS sources=CALLGRID streams=CALLS count=1 sourceIndependent=false',
    'event=SITUATION_POTENTIAL scenario=PROJECTOR crossDomain=2 sourceIndependent=1 eliminatedSameSource=1',
    'event=SITUATION_CONNECTIVITY_SUMMARY bounded=false linksCreated=0 modelCalls=0',
  ]);
  // Either bound reported: the projector's inventory bound counts too.
  const x = await world();
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...x.deps, connectivity: async () => ({ ...CONNECTIVITY, relationshipsBounded: true }) as never });
  assert.ok(x.out.includes('event=SITUATION_CONNECTIVITY_SUMMARY bounded=true linksCreated=0 modelCalls=0'));
});

test('connectivity cannot leak: a code field carrying text prints UNRECOGNIZED; no id, name or contact appears', async () => {
  const w = await world();
  const hostile = {
    ...CONNECTIVITY,
    relationships: [{ linkClass: 'Acme Insurance Group', records: 1, links: 0, rejected: { 'dana@acme.test': 1 } }],
    projector: { ...CONNECTIVITY.projector, composition: [{ domains: ['CREATORS', 'party p1 Dana'], sources: ['org_live_1 x'], count: 1, sourceIndependent: true }] },
  };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, connectivity: async () => hostile as never });
  const text = w.out.join('\n');
  for (const secret of ['Acme', 'dana@', 'Dana', 'org_live_1', w.matt.id]) assert.equal(text.includes(secret), false, secret);
  assert.match(text, /linkClass=UNRECOGNIZED records=1 links=0 rejected=UNRECOGNIZED:1/);
  assert.match(text, /domains=CREATORS\+UNRECOGNIZED sources=UNRECOGNIZED/);
});

test('connectivity wiring: the same read-only service, no runtime, no model; the reader and the projector have no write path and create no link', () => {
  const runner = readFileSync(join(__dirname, 'read-intelligence-state.ts'), 'utf8');
  assert.match(runner, /const connectivity = \(organizationId: string\) => situationService\.connectivity\(organizationId\);/);
  const strip = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const reader = strip(join(__dirname, '..', '..', 'packages', 'database', 'src', 'repositories', 'intelligence', 'situation-connectivity.repository.ts'));
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'declare(', 'EntityLinkRepository', 'fetch(']) {
    assert.equal(reader.includes(forbidden), false, `${forbidden} has no place in a read-only diagnosis`);
  }
  for (const column of ['email: true', 'phone: true', 'firstName: true', 'lastName: true', 'displayName: true', 'title: true', 'summary: true']) assert.equal(reader.includes(column), false, `never selects ${column}`);
  // Every query is scoped to the organization.
  const calls = [...reader.matchAll(/\.(count|findMany|findFirst|groupBy)\(\{\s*(?:by: [^\]]+\],\s*)?where:\s*([^,}]+)/g)];
  assert.equal(calls.length, 5, 'two member groupings, three Party counts');
  for (const [, op, where] of calls) assert.match(where!, /^(window|\{ \.\.\.org)/, `${op} is organization-scoped`);
  assert.match(reader, /const window = \{ \.\.\.org, sourceOccurredAt/);
  // The governed relationships come from the ONE projector the pass uses: read-only, organization-scoped,
  // and it selects no name, contact or content column but a digest's own signal list.
  const projector = strip(join(__dirname, '..', '..', 'packages', 'database', 'src', 'repositories', 'intelligence', 'governed-entity-links.repository.ts'));
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'EntityLinkRepository', 'fetch(']) {
    assert.equal(projector.includes(forbidden), false, `the projector has no ${forbidden}`);
  }
  const reads = [...projector.matchAll(/\.(findMany|findFirst|count)\(\{\s*where:\s*\{\s*([^,}]+)/g)];
  assert.equal(reads.length, 7, 'Parties, Customer links, their Customers, Creator profiles, Work origins, Work instances, digests');
  for (const [, op, first] of reads) assert.match(first!, /^(\.\.\.org|organizationId)$/, `${op} is organization-scoped first`);
  for (const column of ['email: true', 'phone: true', 'name: true', 'firstName: true', 'lastName: true', 'displayName: true', 'label: true', 'title: true']) assert.equal(projector.includes(column), false, `never selects ${column}`);
  // Pipeline naming reads intake eligibility -- the same read-only repository every intake surface uses.
  assert.match(reader, /new IntakeEligibilityRepository\(this\.db\)\.read\(organizationId, now\)/);
  const intake = strip(join(__dirname, '..', '..', 'packages', 'database', 'src', 'repositories', 'intake-eligibility.repository.ts'));
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'lastSeenAt']) {
    assert.equal(intake.includes(forbidden), false, `intake eligibility has no ${forbidden}`);
  }
  for (const [, op, where] of intake.matchAll(/\.(count|findMany)\(\{\s*where:\s*([^,}]+)/g)) {
    if (where!.startsWith('after ?')) continue; // the pager composes its caller's where -- checked just below
    assert.match(where!, /org|organizationId/, `${op} is organization-scoped`);
  }
  const paged = [...intake.matchAll(/await this\.page\(\s*[^,]+,\s*(\{[^\n]*)/g)];
  assert.equal(paged.length, 4, 'notes, status changes, Party links, web leads');
  for (const [, where] of paged) assert.match(where!, /\.\.\.org|AND: \[org/, 'every paged read is organization-scoped');
});

const COMPOSITION = {
  records: 24_590,
  byStatus: [
    { status: 'ABSENT', total: 3, working: 3, stalled: 3, eligible: 0 },
    { status: 'NEW', total: 16_380, working: 16_380, stalled: 16_372, eligible: 1 },
    { status: 'CONTACTED', total: 8_195, working: 8_195, stalled: 8_190, eligible: 0 },
    { status: 'QUOTED', total: 9, working: 9, stalled: 9, eligible: 0 },
    { status: 'BOOKED', total: 2, working: 0, stalled: 0, eligible: 0 },
    { status: 'COMPLETED', total: 0, working: 0, stalled: 0, eligible: 0 },
    { status: 'ARCHIVED', total: 1, working: 0, stalled: 0, eligible: 0 },
    { status: 'OTHER', total: 0, working: 0, stalled: 0, eligible: 0 },
  ],
  byProvenance: [
    { provenance: 'CALLGRID_INGESTION_CALLER_ONLY', basis: 'VERIFIED', total: 24_570, working: 24_569, stalled: 24_560, humanWork: 0, eligible: 0 },
    { provenance: 'UNKNOWN', basis: 'UNKNOWN', total: 20, working: 18, stalled: 15, humanWork: 2, eligible: 1 },
  ],
  intake: {
    counts: { complete: true, totalRecords: 24_590, eligible: 1, excluded: 24_589, byStatus: { New: 1, Contacted: 0, Quoted: 0, Booked: 0, Completed: 0, Archived: 0, UNSET: 0 }, byBasis: { WEB_LEAD: 1, HUMAN_WORK: 0 }, working: 1, stalled: { New: 1, Contacted: 0, Quoted: 0 } },
    byWorkEvent: { HUMAN_NOTE: 0, STATUS_CHANGE: 0, PARTY_LINK: 0 },
    worked: 0,
    neverWorked: 1,
  },
  humanWork: { bySignal: { HUMAN_NOTE: 0, USER_ACTION: 2, USER_PARTY_LINK: 0 }, any: 2, stalledAny: 1 },
  clock: { all: { lastSeenEqualsCreated: 24_589, lastSeenAfterCreated: 1, lastSeenBeforeCreated: 0 }, stalled: { lastSeenEqualsCreated: 24_574, lastSeenAfterCreated: 1, lastSeenBeforeCreated: 0 } },
  cutoff: { at: '2026-09-15T13:49:40.000Z', createdBefore: { total: 24_580, working: 24_577, stalled: 24_575 }, createdAfter: { total: 10, working: 10, stalled: 0 }, afterWithIngestionMark: 3 },
  months: [{ month: '2026-07', total: 12_591, working: 12_590, stalled: 12_589 }],
  stalledActivity: { windowDays: 14, byKind: { ROW_UPDATED: 4, INTERACTION: 0, HUMAN_NOTE: 0, CONVERSATION: 0, BOOKING: 0, ORDER: 0, SERVICE_REQUEST: 0, USER_ACTION: 0, SYSTEM_AUDIT: 0, WORKFLOW_RUN: 0, PARTY_LINK: 0 }, any: 4, human: 0, none: 24_571 },
  nameable: { stalled: 24_575, nameable: 24_575 },
  complete: true,
  incomplete: [],
} as const;

test('pipeline composition prints status, provenance with basis, human work, clock, cutoff, months, stalled activity and nameable -- counts only', async () => {
  const w = await world();
  let cutoff: Date | null = null;
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, pipeline: async (_org, slice1At) => ((cutoff = slice1At), COMPOSITION as never) });
  assert.equal((cutoff as Date | null)?.toISOString(), '2026-09-15T13:49:40.000Z', 'the governed Slice 1 cutoff (#239 merged), never one invented here');
  const lines = w.out.filter((l) => l.startsWith('event=PIPELINE_'));
  assert.deepEqual(lines.slice(0, 3), [
    'event=PIPELINE_STATUS status=ABSENT total=3 v1Working=3 v1Stalled=3 eligible=0',
    'event=PIPELINE_STATUS status=NEW total=16380 v1Working=16380 v1Stalled=16372 eligible=1',
    'event=PIPELINE_STATUS status=CONTACTED total=8195 v1Working=8195 v1Stalled=8190 eligible=0',
  ]);
  for (const expected of [
    'event=PIPELINE_PROVENANCE provenance=CALLGRID_INGESTION_CALLER_ONLY basis=VERIFIED total=24570 v1Working=24569 v1Stalled=24560 humanWork=0 eligible=0',
    'event=PIPELINE_PROVENANCE provenance=UNKNOWN basis=UNKNOWN total=20 v1Working=18 v1Stalled=15 humanWork=2 eligible=1',
    'event=PIPELINE_INTAKE eligible=1 excluded=24589 basisWebLead=1 basisHumanWork=0 working=1 complete=true',
    'event=PIPELINE_INTAKE_STATUS status=NEW count=1 stalled=1',
    'event=PIPELINE_INTAKE_STATUS status=CONTACTED count=0 stalled=0',
    'event=PIPELINE_INTAKE_STATUS status=UNSET count=0 stalled=-',
    'event=PIPELINE_INTAKE_WORK clock=WORK staleDays=14 HUMAN_NOTE=0 STATUS_CHANGE=0 PARTY_LINK=0 worked=0 neverWorked=1',
    'event=PIPELINE_HUMAN_WORK HUMAN_NOTE=0 USER_ACTION=2 USER_PARTY_LINK=0 any=2 stalledAny=1',
    'event=PIPELINE_CLOCK scope=ALL lastSeenEqualsCreated=24589 lastSeenAfterCreated=1 lastSeenBeforeCreated=0',
    'event=PIPELINE_CLOCK scope=STALLED lastSeenEqualsCreated=24574 lastSeenAfterCreated=1 lastSeenBeforeCreated=0',
    'event=PIPELINE_CUTOFF basis=SLICE1_MERGED_AT at=2026-09-15T13:49:40.000Z createdBefore=24580 workingBefore=24577 stalledBefore=24575 createdAfter=10 workingAfter=10 stalledAfter=0 afterWithIngestionMark=3',
    'event=PIPELINE_MONTH month=2026-07 created=12591 working=12590 stalled=12589',
    'event=PIPELINE_STALLED_ACTIVITY windowDays=14 ROW_UPDATED=4 INTERACTION=0 HUMAN_NOTE=0 CONVERSATION=0 BOOKING=0 ORDER=0 SERVICE_REQUEST=0 USER_ACTION=0 SYSTEM_AUDIT=0 WORKFLOW_RUN=0 PARTY_LINK=0 any=4 human=0 none=24571',
    'event=PIPELINE_NAMEABLE stalled=24575 nameable=24575',
    'event=PIPELINE_COMPOSITION_SUMMARY records=24590 complete=true bounded=false incomplete=-',
  ]) assert.ok(lines.includes(expected), expected);
});

test('pipeline composition cannot leak or overclaim: text prints UNRECOGNIZED; an incomplete read is bounded=true with its codes', async () => {
  const w = await world();
  const hostile = { ...COMPOSITION, byProvenance: [{ provenance: 'dana@acme.test', basis: 'Acme Insurance Group', total: 1, working: 1, stalled: 1, humanWork: 0, eligible: 0 }], complete: false, incomplete: ['RECORDS', 'Please call me'] };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, pipeline: async () => hostile as never });
  const text = w.out.join('\n');
  for (const secret of ['dana@', 'Acme', 'Please call me']) assert.equal(text.includes(secret), false, secret);
  assert.match(text, /provenance=UNRECOGNIZED basis=UNRECOGNIZED/);
  assert.match(text, /complete=false bounded=true incomplete=RECORDS,UNRECOGNIZED/);
});

test('pipeline composition wiring and reader: read-only client, the governed cutoff, no write, and no content column ever selected', () => {
  const runner = readFileSync(join(__dirname, 'read-intelligence-state.ts'), 'utf8');
  assert.match(runner, /import \{ SLICE1_MERGED_AT \} from '\.\/read-people-population';/);
  assert.match(runner, /new PipelineCompositionRepository\(readOnlyClient\(prisma\)\)/);
  const strip = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const reader = strip(join(__dirname, '..', '..', 'packages', 'database', 'src', 'repositories', 'intelligence', 'pipeline-composition.repository.ts'));
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'fetch(']) assert.equal(reader.includes(forbidden), false, forbidden);
  // Customer fields are matched in the query; the only values ever selected are ids, timestamps and a run's input.
  for (const column of ['email: true', 'phone: true', 'firstName: true', 'lastName: true', 'attributes: true', 'metadata: true', 'tags: true', 'externalId: true', 'payload: true', 'body: true']) {
    assert.equal(reader.includes(column), false, `never selects ${column}`);
  }
  // Every read names the organization.
  assert.equal((reader.match(/\{ \.\.\.org,|inOrg\(|, org, 'id'/g) ?? []).length >= 20, true);
});

test('a value that is not a code token prints as UNRECOGNIZED, never as itself', () => {
  assert.equal(token('volume-drop'), 'volume-drop');
  assert.equal(token('daily:2026-09-19..2026-09-20'), 'daily:2026-09-19..2026-09-20');
  assert.equal(token('relationship.*'), 'relationship.*');
  assert.equal(token(null), null);
  for (const text of ['Acme Insurance Group', 'dana@acme.test', 'a=b c=d', 'x\ny']) assert.equal(token(text), 'UNRECOGNIZED');
});

test('the runner and the reader have no write path, and production runs the reader on a read-only client', () => {
  const strip = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const runner = strip(join(__dirname, 'read-intelligence-state.ts'));
  const reader = strip(join(__dirname, '..', '..', 'packages', 'database', 'src', 'repositories', 'intelligence-state.repository.ts'));
  for (const code of [runner, reader]) {
    for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'fetch(']) {
      assert.equal(code.includes(forbidden), false, `${forbidden} has no place in a read-only diagnosis`);
    }
  }
  for (const column of ['title: true', 'summary: true', 'note: true', 'reason: true', 'entityName', 'entityId: true', 'statement', 'displayName', 'email', 'body: true', 'toAddresses']) {
    assert.equal(reader.includes(column), false, `the reader never selects ${column}`);
  }
  assert.match(runner, /new IntelligenceStateRepository\(readOnlyClient\(prisma\)\)/, 'production wiring wraps the client');
  // Every query the reader makes is scoped to the organization.
  const calls = [...reader.matchAll(/\.(count|findMany|findFirst)\(\{\s*where:\s*([^,}]+)/g)].filter(([, , w]) => !w!.includes('slug'));
  assert.ok(calls.length >= 20);
  for (const [, op, where] of calls) assert.match(where!, /org|created|\{ \.\.\.org/, `${op} is organization-scoped`);
});

test('the CallGrid producer the reader looks for is the one the CallGrid pipeline records', () => {
  const web = readFileSync(join(__dirname, '..', '..', 'apps', 'web', 'src', 'app', 'app', 'admin', 'marketplace', 'operational-queue-data.ts'), 'utf8');
  assert.match(web, new RegExp(`export const CALLGRID_SOURCE = "${CALLGRID_CASE_PRODUCER}";`));
});

// --- The workflow, and its input step executed ------------------------------------------------

const WORKFLOW = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'read-intelligence-state.yml'), 'utf8');

/** The `run: |` body of the named step, dedented. */
function stepScript(name: string): string {
  const lines = WORKFLOW.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `the workflow has a step named ${name}`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = lines[run]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

function validate(slugInput: string, sinceInput = ''): { code: number; slug: string | null; since: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'ris-input-'));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', stepScript('Validate the requested input')], {
    env: { PATH: process.env.PATH ?? '', ORG_SLUG: slugInput, SINCE: sinceInput, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  const written = readFileSync(output, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { code: run.status ?? -1, slug: /^slug=(.*)$/m.exec(written)?.[1] ?? null, since: /^since=(.*)$/m.exec(written)?.[1] ?? null };
}

test('the workflow is human-started only, proves safety before reading, and interpolates no input', () => {
  assert.ok(WORKFLOW.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.equal(WORKFLOW.includes(trigger), false, `no ${trigger.trim()}`);
  }
  assert.match(WORKFLOW, /\npermissions:\n  contents: read\n/);
  const proof = WORKFLOW.indexOf('npm run test:operations');
  const read = WORKFLOW.indexOf('npm run read:intelligence-state');
  assert.ok(proof > 0 && proof < read, 'the safety proof runs before the read');
  for (const forbidden of ['migrate deploy', 'db push', '--apply', 'OUTBOX_DRAIN', 'INTELLIGENCE_DETECT']) assert.equal(WORKFLOW.includes(forbidden), false, forbidden);
  for (const body of WORKFLOW.split(/\n\s+run: \|/).slice(1)) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.equal(/\$\{\{\s*inputs\./.test(step), false, 'no input interpolated into a run body');
  }
});

test('a valid slug with whitespace around it is trimmed and validated, as in Read Employee Sources (#303)', () => {
  for (const input of ['servicesinmycity-demo', '    servicesinmycity-demo', 'servicesinmycity-demo   ', '\tservicesinmycity-demo\n', ' \t servicesinmycity-demo \r\n']) {
    const result = validate(input);
    assert.equal(result.code, 0, JSON.stringify(input));
    assert.equal(result.slug, 'servicesinmycity-demo');
    assert.equal(result.since, '', 'no moment given: the runner reads the last day');
  }
  for (const input of ['', '   ', 'services inmycity-demo', 'servicesinmycity-demo\nother-org', 'Servicesinmycity-Demo', '-leading-hyphen', 'org;rm', 'a'.repeat(64)]) {
    const result = validate(input);
    assert.notEqual(result.code, 0, `${JSON.stringify(input)} must be refused`);
    assert.equal(result.slug, null, 'nothing is passed on');
  }
});

test('the moment is trimmed and must be a UTC instant, or empty', () => {
  for (const [input, expected] of [['', ''], ['  2026-09-19T18:00:00Z ', '2026-09-19T18:00:00Z'], ['2026-09-19T18:00Z', '2026-09-19T18:00Z'], ['2026-09-19T18:00:00.123Z', '2026-09-19T18:00:00.123Z']] as const) {
    const result = validate('servicesinmycity-demo', input);
    assert.equal(result.code, 0, JSON.stringify(input));
    assert.equal(result.since, expected);
  }
  for (const input of ['yesterday', '2026-09-19', '2026-09-19T18:00:00+02:00', '2026-09-19T18:00:00Z\n2026-01-01T00:00:00Z', '$(id)']) {
    const result = validate('servicesinmycity-demo', input);
    assert.notEqual(result.code, 0, `${JSON.stringify(input)} must be refused`);
    assert.equal(result.slug, null);
  }
});

test('the read step uses the validated values, never the raw inputs', () => {
  const read = WORKFLOW.slice(WORKFLOW.indexOf('- name: Read\n'), WORKFLOW.indexOf('- name: How to read the output'));
  assert.match(read, /ORG_SLUG: \$\{\{ steps\.input\.outputs\.slug \}\}/);
  assert.match(read, /SINCE: \$\{\{ steps\.input\.outputs\.since \}\}/);
  assert.equal(read.includes('inputs.organization_slug'), false);
  assert.equal(read.includes('inputs.since'), false);
});

// --- Domain readings and the AI ledger (2026-09-29) ------------------------------------------------
const READINGS = {
  readings: [
    { scope: 'ORGANIZATION', domain: 'CALLGRID', status: 'CURRENT', producerKind: 'RULE_AND_MODEL', modelStage: 'MODEL_READ', taskId: 'callgrid.domain.reading', digests: 1, withInvocation: 1, linked: 1, ledgerOutcomes: { ANSWERED: 1 }, providers: { anthropic: 1 }, latestGeneratedAt: new Date('2026-09-29T10:00:00Z') },
    { scope: 'ORGANIZATION', domain: 'PIPELINE', status: 'CURRENT', producerKind: 'RULE', modelStage: 'REJECTED_OUTPUT:UNSUPPORTED_NUMBER_IN_TEXT', taskId: null, digests: 1, withInvocation: 0, linked: 0, ledgerOutcomes: {}, providers: {}, latestGeneratedAt: new Date('2026-09-29T09:00:00Z') },
    { scope: 'PRINCIPAL', domain: 'CALENDAR', status: 'CURRENT', producerKind: 'RULE_AND_MODEL', modelStage: 'MODEL_READ', taskId: 'calendar.domain.reading', digests: 2, withInvocation: 2, linked: 2, ledgerOutcomes: { ANSWERED: 2 }, providers: { anthropic: 2 }, latestGeneratedAt: new Date('2026-09-29T11:00:00Z') },
  ],
  ledger: [
    { taskId: 'callgrid.domain.reading', providerId: 'anthropic', outcome: 'ANSWERED', lane: 'BACKGROUND', failureClass: null, count: 3 },
    { taskId: 'pipeline.domain.reading', providerId: 'anthropic', outcome: 'REJECTED_BY_LOOP', lane: 'BACKGROUND', failureClass: null, count: 1 },
  ],
  rejections: [{ taskId: 'pipeline.domain.reading', code: 'UNSUPPORTED_NUMBER_IN_TEXT', count: 1 }],
  windows: [],
  latency: [],
  contentHolds: [],
  bounded: false,
} as const;

test('domain readings print mode, model stage, task and the ledger call behind each -- counts and codes only, for the requested window', async () => {
  const w = await world();
  const asked: [string, string][] = [];
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '2026-09-19T00:00:00Z' }, { ...w.deps, readings: async (organizationId, since) => (asked.push([organizationId, since.toISOString()]), READINGS as never) });
  assert.deepEqual(asked, [['org_live_1', '2026-09-19T00:00:00.000Z']], 'the resolved organization and the requested window');
  assert.deepEqual(w.out.filter((l) => /^event=(INTELLIGENCE_READING|AI_LEDGER)/.test(l)), [
    'event=INTELLIGENCE_READING scope=ORGANIZATION domain=CALLGRID status=CURRENT kind=RULE_AND_MODEL modelStage=MODEL_READ task=callgrid.domain.reading digests=1 withInvocation=1 ledgerLinked=1 ledgerOutcome=ANSWERED:1 provider=anthropic:1 latestGeneratedAt=2026-09-29T10:00:00.000Z',
    'event=INTELLIGENCE_READING scope=ORGANIZATION domain=PIPELINE status=CURRENT kind=RULE modelStage=REJECTED_OUTPUT:UNSUPPORTED_NUMBER_IN_TEXT task=- digests=1 withInvocation=0 ledgerLinked=0 ledgerOutcome=- provider=- latestGeneratedAt=2026-09-29T09:00:00.000Z',
    'event=INTELLIGENCE_READING scope=PRINCIPAL domain=CALENDAR status=CURRENT kind=RULE_AND_MODEL modelStage=MODEL_READ task=calendar.domain.reading digests=2 withInvocation=2 ledgerLinked=2 ledgerOutcome=ANSWERED:2 provider=anthropic:2 latestGeneratedAt=2026-09-29T11:00:00.000Z',
    'event=AI_LEDGER task=callgrid.domain.reading provider=anthropic outcome=ANSWERED lane=BACKGROUND failureClass=- count=3',
    'event=AI_LEDGER task=pipeline.domain.reading provider=anthropic outcome=REJECTED_BY_LOOP lane=BACKGROUND failureClass=- count=1',
    'event=AI_LEDGER_REJECTION task=pipeline.domain.reading code=UNSUPPORTED_NUMBER_IN_TEXT count=1',
    'event=INTELLIGENCE_READING_SUMMARY readings=4 currentModelBacked=3 ledgerCalls=4 ledgerAnswered=3 bounded=false',
  ]);
});

test('domain readings cannot leak: a code field carrying text prints UNRECOGNIZED; no id, statement or provider text appears', async () => {
  const w = await world();
  const hostile = { ...READINGS, readings: [{ ...READINGS.readings[0], modelStage: 'FAILED: provider said Acme Insurance Group', taskId: 'org_live_1 task' }], ledger: [{ ...READINGS.ledger[0], failureClass: 'dana@acme.test' }], rejections: [{ taskId: 'x', code: 'Please call me', count: 1 }] };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, readings: async () => hostile as never });
  const text = w.out.join('\n');
  for (const secret of ['Acme', 'org_live_1', 'dana@', 'Please call me', w.matt.id]) assert.equal(text.includes(secret), false, secret);
  assert.match(text, /modelStage=UNRECOGNIZED task=UNRECOGNIZED/);
  assert.match(text, /failureClass=UNRECOGNIZED/);
});

test('domain readings wiring: a read-only client; the reader selects no content, subject, user, prompt or answer and writes nothing', () => {
  const runner = readFileSync(join(__dirname, 'read-intelligence-state.ts'), 'utf8');
  assert.match(runner, /const readingState = new IntelligenceReadingStateRepository\(readOnlyClient\(prisma\)\);/);
  const strip = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const reader = strip(join(__dirname, '..', '..', 'packages', 'database', 'src', 'repositories', 'intelligence', 'intelligence-reading-state.repository.ts'));
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', '$transaction', 'fetch(']) assert.equal(reader.includes(forbidden), false, forbidden);
  for (const column of ['content: true', 'subjectRef: true', 'userId: true', 'principalUserId: true', 'entityRefs: true', 'providerRequestId: true', 'contentCursor: true']) assert.equal(reader.includes(column), false, `never selects ${column}`);
  // The window hash is read to count repeats and never leaves: no returned type names it.
  assert.equal(/readonly contextManifestHash/.test(reader), false, 'no returned shape carries the window hash');
  const reads = [...reader.matchAll(/\.findMany\(\{\s*where:\s*\{\s*([^,}]+)/g)];
  assert.equal(reads.length, 4, 'digests, the calls they name, the window of calls, the content authorizations');
  for (const [, first] of reads) assert.equal(first!.trim(), 'organizationId', 'every read is organization-scoped first');
});

test('telegram triage repetition, latency and content holds print as counts and codes -- never a window hash, a person or text', async () => {
  const w = await world();
  const state = {
    ...READINGS,
    windows: [{ taskId: 'telegram.content.triage', calls: 69, distinctWindows: 9, repeatedWindows: 5, maxCallsPerWindow: 21, repeatedCalls: { FAILED: 21, REJECTED_BY_LOOP: 31, ANSWERED: 3 }, timeouts: 21, answerTooLong: 31 }],
    latency: [
      { taskId: 'telegram.content.triage', outcome: 'ANSWERED', count: 15, p50Ms: 14200, p95Ms: 19100, maxMs: 19800 },
      { taskId: 'telegram.content.triage', outcome: 'FAILED', count: 21, p50Ms: 20000, p95Ms: 20003, maxMs: 20010 },
    ],
    contentHolds: [{ provider: 'TELEGRAM', failureClass: 'REFUSED_BY_LOOP:BUDGET_TASK_EXHAUSTED', authorizations: 1, backingOff: 0 }],
    rejections: [{ taskId: 'telegram.content.triage', code: 'TOO_LONG_LIMITATION', count: 12 }],
  };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, readings: async () => state as never });
  assert.deepEqual(w.out.filter((l) => /^event=(AI_TASK_WINDOWS|AI_TASK_LATENCY|CONTENT_HOLD|AI_LEDGER_REJECTION) /.test(l)), [
    'event=AI_LEDGER_REJECTION task=telegram.content.triage code=TOO_LONG_LIMITATION count=12',
    'event=AI_TASK_WINDOWS task=telegram.content.triage calls=69 distinctWindows=9 repeatedWindows=5 maxCallsPerWindow=21 repeatedCalls=ANSWERED:3,FAILED:21,REJECTED_BY_LOOP:31 timeouts=21 answerTooLong=31',
    'event=AI_TASK_LATENCY task=telegram.content.triage outcome=ANSWERED count=15 p50Ms=14200 p95Ms=19100 maxMs=19800',
    'event=AI_TASK_LATENCY task=telegram.content.triage outcome=FAILED count=21 p50Ms=20000 p95Ms=20003 maxMs=20010',
    'event=CONTENT_HOLD provider=TELEGRAM failureClass=REFUSED_BY_LOOP:BUDGET_TASK_EXHAUSTED authorizations=1 backingOff=0',
  ]);
});

// --- Website evidence (2026-09-30): counts and codes only; the four external sources are NOT_CONNECTED ------

const WEBSITE_STATE = {
  properties: {
    total: 17,
    byLifecycle: { OWNED: 12, BUILDING: 2, LIVE: 2, PAUSED: 1, RETIRED: 0 },
    byAdmission: { KNOWN_NOT_LIVE: 15, LIVE_INGESTING: 1, LIVE_INGESTION_DISABLED: 1 },
    unrecognized: 0,
    ga4Bound: 1, searchConsoleBound: 0, bingBound: 0, clarityBound: 0,
  },
  events: { total: 40, byClass: { PAGE_VIEW: 20, SESSION: 6, ENGAGEMENT: 4, INTENT: 2, TELEMETRY: 8, OTHER: 0 }, newestAt: new Date('2026-09-19T18:00:00Z') },
  refusals: { DOMAIN_NOT_ALLOWED: 2, PROPERTY_MISMATCH: 1 },
  sources: [
    { sourceId: 'WEBSITE_EVENTS', stream: 'SITE_VISITS', basis: 'LOOP_RECORDS', connection: 'CONNECTED', coverage: 'COVERED', newestWindowEnd: new Date('2026-09-19T18:00:00Z'), finality: null, sampled: null, thresholded: null, rolledUp: null, truncated: null },
    { sourceId: 'GOOGLE_ANALYTICS', stream: 'SITE_VISITS', basis: 'ORGANIZATION_CONNECTION', connection: 'NOT_CONNECTED', coverage: 'GAP_NOT_CONNECTED', newestWindowEnd: null, finality: null, sampled: null, thresholded: null, rolledUp: null, truncated: null },
    { sourceId: 'MICROSOFT_CLARITY', stream: 'SITE_VISITS', basis: 'ORGANIZATION_CONNECTION', connection: 'NOT_CONNECTED', coverage: 'GAP_NOT_CONNECTED', newestWindowEnd: null, finality: null, sampled: null, thresholded: null, rolledUp: null, truncated: null },
    { sourceId: 'GOOGLE_SEARCH_CONSOLE', stream: 'SEARCH_GOOGLE', basis: 'ORGANIZATION_CONNECTION', connection: 'NOT_CONNECTED', coverage: 'GAP_NOT_CONNECTED', newestWindowEnd: null, finality: null, sampled: null, thresholded: null, rolledUp: null, truncated: null },
    { sourceId: 'BING_WEBMASTER', stream: 'SEARCH_BING', basis: 'ORGANIZATION_CONNECTION', connection: 'NOT_CONNECTED', coverage: 'GAP_NOT_CONNECTED', newestWindowEnd: null, finality: null, sampled: null, thresholded: null, rolledUp: null, truncated: null },
  ],
};

test('25: website evidence prints WEBSITE_PROPERTY / WEBSITE_EVENTS / WEBSITE_REFUSALS / SOURCE_COVERAGE -- counts and codes only', async () => {
  const w = await world();
  const out: string[] = [];
  const asked: string[] = [];
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, log: (l) => void out.push(l), website: async (organizationId) => (asked.push(organizationId), WEBSITE_STATE as never) });
  assert.deepEqual(asked, ['org_live_1']);
  const lines = out.filter((l) => /event=(WEBSITE_|SOURCE_COVERAGE)/.test(l));
  assert.ok(lines.includes('event=WEBSITE_PROPERTY registered=17 OWNED=12 BUILDING=2 LIVE=2 PAUSED=1 RETIRED=0 unrecognized=0 ga4Bound=1 searchConsoleBound=0 bingBound=0 clarityBound=0'));
  // The four states the registry distinguishes, each stated -- a known, not-live property is never a gap.
  assert.ok(lines.includes('event=WEBSITE_PROPERTY_STATE state=KNOWN_NOT_LIVE count=15 gap=false'));
  assert.ok(lines.includes('event=WEBSITE_PROPERTY_STATE state=LIVE_INGESTING count=1 gap=false'));
  assert.ok(lines.includes('event=WEBSITE_PROPERTY_STATE state=LIVE_INGESTION_DISABLED count=1 gap=false'));
  assert.ok(lines.includes('event=WEBSITE_PROPERTY_STATE state=UNREGISTERED count=NOT_DURABLE gap=false'));
  assert.ok(lines.some((l) => l.startsWith('event=WEBSITE_EVENTS ') && l.includes('total=40 PAGE_VIEW=20 SESSION=6 ENGAGEMENT=4 INTENT=2 TELEMETRY=8 OTHER=0')));
  assert.ok(lines.includes('event=WEBSITE_REFUSALS connection=PRESENT DOMAIN_NOT_ALLOWED=2 PROPERTY_MISMATCH=1 unregistered=NOT_DURABLE'));
  for (const id of ['GOOGLE_ANALYTICS', 'MICROSOFT_CLARITY', 'GOOGLE_SEARCH_CONSOLE', 'BING_WEBMASTER']) {
    assert.ok(lines.some((l) => l.startsWith(`event=SOURCE_COVERAGE source=${id} `) && l.includes('declared=DECLARED connection=NOT_CONNECTED coverage=GAP_NOT_CONNECTED newest=- finality=-')), id);
  }
  assert.ok(lines.some((l) => l.startsWith('event=SOURCE_COVERAGE source=WEBSITE_EVENTS stream=SITE_VISITS') && l.includes('connection=CONNECTED')));
});

test('25: website diagnostics cannot leak -- hostile values print UNRECOGNIZED, never themselves', async () => {
  const w = await world();
  const out: string[] = [];
  const hostile = {
    ...WEBSITE_STATE,
    refusals: { 'jane@example.com': 1, 'https://site.example/?q=x': 2 },
    sources: [{ ...WEBSITE_STATE.sources[1]!, sourceId: 'pk_emg_secret', stream: 'dana@acme.test', connection: 'token abc' as never, coverage: 'jane@x' as never, finality: '/p?email=x' }],
  };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, log: (l) => void out.push(l), website: async () => hostile as never });
  const text = out.filter((l) => /event=(WEBSITE_|SOURCE_COVERAGE)/.test(l)).join('\n');
  assert.doesNotMatch(text, /jane|example|pk_emg|dana|acme|token abc|email=/);
  assert.match(text, /source=UNRECOGNIZED stream=UNRECOGNIZED/);
});

test('a registry of known, not-live properties prints NOT_APPLICABLE coverage -- never a NOT_CONNECTED gap', async () => {
  const w = await world();
  const out: string[] = [];
  const quiet = {
    ...WEBSITE_STATE,
    properties: { ...WEBSITE_STATE.properties, byLifecycle: { OWNED: 16, BUILDING: 1, LIVE: 0, PAUSED: 0, RETIRED: 0 }, byAdmission: { KNOWN_NOT_LIVE: 17, LIVE_INGESTING: 0, LIVE_INGESTION_DISABLED: 0 } },
    events: { ...WEBSITE_STATE.events, total: 0, newestAt: null },
    sources: WEBSITE_STATE.sources.map((s) => ({ ...s, connection: 'NOT_CONNECTED', coverage: 'NOT_APPLICABLE' })),
  };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, log: (l) => void out.push(l), website: async () => quiet as never });
  const coverage = out.filter((l) => l.startsWith('event=SOURCE_COVERAGE'));
  assert.equal(coverage.length, 5);
  assert.ok(coverage.every((l) => l.includes('coverage=NOT_APPLICABLE')));
  assert.equal(out.some((l) => /GAP_/.test(l)), false);
});

// --- Collection health (2026-10-05): a LIVE + ENABLED property with no events must not look healthy ----------

test('WEBSITE_COLLECTION prints per-property delivery health -- keys, states, counts and an age bucket only', async () => {
  const w = await world();
  const out: string[] = [];
  const state = {
    ...WEBSITE_STATE,
    collection: [
      { key: 'careinmycity', lifecycle: 'LIVE', ingestion: 'ENABLED', events: 0, sessions: 0, pageViews: 0, lastEventAge: 'NEVER', verdict: 'NO_EVENTS' },
      { key: 'petsinmycity', lifecycle: 'LIVE', ingestion: 'ENABLED', events: 3, sessions: 1, pageViews: 1, lastEventAge: 'LT_7D', verdict: 'SPARSE' },
      { key: 'servicesinmycity', lifecycle: 'LIVE', ingestion: 'ENABLED', events: 900, sessions: 120, pageViews: 400, lastEventAge: 'LT_1H', verdict: 'FLOWING' },
      { key: 'spasinmycity', lifecycle: 'OWNED', ingestion: 'DISABLED', events: 0, sessions: 0, pageViews: 0, lastEventAge: 'NEVER', verdict: 'NOT_APPLICABLE' },
    ],
  };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, log: (l) => void out.push(l), website: async () => state as never });
  assert.ok(out.includes('event=WEBSITE_COLLECTION property=careinmycity lifecycle=LIVE ingestion=ENABLED windowDays=14 events14d=0 sessions14d=0 pageViews14d=0 lastEventAge=NEVER verdict=NO_EVENTS'));
  assert.ok(out.includes('event=WEBSITE_COLLECTION property=servicesinmycity lifecycle=LIVE ingestion=ENABLED windowDays=14 events14d=900 sessions14d=120 pageViews14d=400 lastEventAge=LT_1H verdict=FLOWING'));
  assert.ok(out.includes('event=WEBSITE_COLLECTION property=spasinmycity lifecycle=OWNED ingestion=DISABLED windowDays=14 events14d=0 sessions14d=0 pageViews14d=0 lastEventAge=NEVER verdict=NOT_APPLICABLE'));
  assert.ok(out.includes('event=WEBSITE_COLLECTION_SUMMARY live=3 flowing=1 sparse=1 noEvents=1'));
});

test('WEBSITE_COLLECTION cannot leak: hostile keys, states and buckets print UNRECOGNIZED', async () => {
  const w = await world();
  const out: string[] = [];
  const state = { ...WEBSITE_STATE, collection: [{ key: 'https://x.example/?q=jane@x', lifecycle: 'visitor v-1', ingestion: 'ENABLED', events: 1, sessions: 0, pageViews: 0, lastEventAge: '2026-10-05T10:00:00Z', verdict: 'OK!' }] };
  await runIntelligenceState({ organizationSlug: 'servicesinmycity-demo', since: '' }, { ...w.deps, log: (l) => void out.push(l), website: async () => state as never });
  const text = out.filter((l) => l.startsWith('event=WEBSITE_COLLECTION')).join('\n');
  assert.doesNotMatch(text, /jane|x\.example|v-1|2026-10-05T10|OK!/);
  assert.match(text, /property=UNRECOGNIZED lifecycle=UNRECOGNIZED ingestion=ENABLED/);
});
