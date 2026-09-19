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
  const fake: any = makeCognitivePrisma({ also: ['organization', 'invitation', 'organizationMembership', 'crmRelationship', 'crmRelationshipEvent', 'crmParticipant'] });
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
  for (const section of ['ORGANIZATION', 'CASES', 'CASE_LOG_SINCE_SUMMARY', 'DUPLICATES', 'WRITES', 'OUTBOX_SUMMARY', 'CREATOR', 'DELIVERY_SUMMARY', 'SUMMARY']) {
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
