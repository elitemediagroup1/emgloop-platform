// Tests for the reconciliation evidence reader.
//
// WHAT THESE PROVE
//
// Most of the effort goes on what this runner CANNOT do, because that is the
// whole claim being made: it reads production and touches nothing. The seams it
// is handed have no write method, so a mutation would have to be written against
// a Prisma delegate or a provider directly — and the source-inspection tests fail
// if either name appears at all.
//
// The behavioural half is small on purpose. A printer has two interesting cases:
// a row that exists, and a row that does not. The second is the one that matters,
// because a printer that skipped a missing date would let a reader scanning the
// output conclude the window was covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BusinessDate, ReconciliationState } from '@emgloop/shared';
import type { ReconciliationDayView } from '@emgloop/database';

import {
  PROVIDER,
  REFUSED_ORGANIZATION_STATUSES,
  STREAM,
  parseArgs,
  parseDates,
  readEnvironment,
  runRead,
  type ReadDeps,
} from './read-reconciliation-evidence';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = readFileSync(join(HERE, 'read-reconciliation-evidence.ts'), 'utf8');
const WORKFLOW_SOURCE = readFileSync(
  join(HERE, '..', '..', '.github', 'workflows', 'read-reconciliation-evidence.yml'),
  'utf8',
);

// The runner and workflow with `//` and `#` prose removed. The "must not name"
// checks are about CODE, and a header sentence explaining that this job cannot
// ingest must not read as the job ingesting.
const RUNNER_CODE = RUNNER_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');
const WORKFLOW_STEPS = WORKFLOW_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };

function dayView(over: Partial<ReconciliationDayView> = {}): ReconciliationDayView {
  return {
    businessDate: '2026-08-11' as BusinessDate,
    timezone: 'America/New_York',
    state: 'UNKNOWN_EXPECTATION',
    ruleVersion: 'provider-reconciliation.v1',
    localStage: 'integration_event',
    counts: {
      providerUnique: 4239,
      providerDuplicateIds: 0,
      localUnique: 0,
      localDuplicateIds: 0,
      intersection: 0,
      providerOnly: 4239,
      localOnly: 0,
      providerOnlyExpected: 3908,
      providerOnlyNotConfigured: 0,
      providerOnlyExcluded: 0,
      providerOnlyUnknownMember: 331,
    },
    evidence: {
      providerRecords: 4239,
      providerUnattributed: 0,
      localRowsScanned: 0,
      localInWindow: 0,
      localUnresolvedOccurrence: 0,
      localMissingIdentity: 0,
      pagesFetched: 43,
      pageCap: 100,
      truncated: false,
    },
    reason: null,
    observedAt: '2026-08-20T12:00:00.000Z',
    reconciledAt: '2026-08-20T12:00:00.000Z',
    members: [
      {
        dimension: 'CAMPAIGN',
        memberExternalId: 'campaign-fixture-a',
        providerCount: 3908,
        providerOnly: 3908,
        localCount: 0,
        localOnly: 0,
        expectationState: 'EXPECTED',
        expectationId: 'decl_1',
        expectationMatches: 1,
        labelAtObservation: 'A Campaign',
      },
    ],
    ...over,
  };
}

interface Harness {
  lines: string[];
  asked: Array<{ organizationId: string; provider: string; stream: string; businessDate: BusinessDate }>;
  deps: ReadDeps;
}

function harness(
  answer: (date: BusinessDate) => ReconciliationDayView | null,
  organization: { id: string; slug: string; name: string; status: string } | null = ORG,
): Harness {
  const lines: string[] = [];
  const asked: Harness['asked'] = [];
  return {
    lines,
    asked,
    deps: {
      organizations: {
        async findBySlug() {
          return organization;
        },
      },
      reconciliations: {
        async findDay(organizationId, provider, stream, businessDate) {
          asked.push({ organizationId, provider, stream, businessDate });
          return answer(businessDate);
        },
      },
      log: (l) => lines.push(l),
    },
  };
}

const request = (dates: BusinessDate[]) => ({ organizationSlug: ORG.slug, dates });

const OUTAGE: BusinessDate[] = ['2026-08-11', '2026-08-12', '2026-08-13'];

// --- 1, 3: everything requested is reported, with the whole evidence block -------

test('1. every requested date is reported, in the order supplied', async () => {
  const h = harness((d) => dayView({ businessDate: d }));
  const result = await runRead(request(OUTAGE), h.deps);
  assert.equal(result.overall, 'READ');
  assert.deepEqual(result.found, OUTAGE);
  assert.deepEqual(
    h.asked.map((a) => a.businessDate),
    OUTAGE,
  );
  for (const d of OUTAGE) {
    assert.ok(
      h.lines.some((l) => l.includes('event=DAY_EVIDENCE') && l.includes(`businessDate=${d}`)),
      `${d} must have its own line`,
    );
  }
});

test('3. the complete stored evidence block is printed, not a summary of it', async () => {
  const h = harness(() => dayView());
  await runRead(request(['2026-08-11']), h.deps);
  const local = h.lines.find((l) => l.includes('event=DAY_LOCAL_EVIDENCE')) ?? '';
  for (const field of [
    'localRowsScanned=0',
    'localInWindow=0',
    'localUnresolvedOccurrence=0',
    'localMissingIdentity=0',
    'truncated=false',
  ]) {
    assert.ok(local.includes(field), `the local evidence line must carry ${field}`);
  }
  const day = h.lines.find((l) => l.includes('event=DAY_EVIDENCE')) ?? '';
  for (const field of [
    'rowFound=true',
    'state=UNKNOWN_EXPECTATION',
    'reconciled=false',
    'providerUnique=4239',
    'localUnique=0',
    'intersection=0',
    'providerOnly=4239',
    'localOnly=0',
  ]) {
    assert.ok(day.includes(field), `the day line must carry ${field}`);
  }
  const provider = h.lines.find((l) => l.includes('event=DAY_PROVIDER_EVIDENCE')) ?? '';
  for (const field of ['providerRecords=4239', 'pagesFetched=43', 'pageCap=100', 'providerUnattributed=0']) {
    assert.ok(provider.includes(field), `the provider evidence line must carry ${field}`);
  }
});

test('3b. THE AUGUST 11 QUESTION is answerable from the output alone', async () => {
  // Zero local with zero rows scanned means nothing was received. Zero local with
  // rows scanned means things arrived and none belonged to the day. This tool
  // exists to tell those apart, so both shapes are pinned.
  const nothingArrived = harness(() => dayView());
  await runRead(request(['2026-08-11']), nothingArrived.deps);
  assert.ok(
    nothingArrived.lines.some((l) => l.includes('localRowsScanned=0') && l.includes('localInWindow=0')),
  );

  const arrivedElsewhere = harness(() =>
    dayView({
      evidence: { ...dayView().evidence, localRowsScanned: 1204, localInWindow: 0, localUnresolvedOccurrence: 1204 },
    }),
  );
  await runRead(request(['2026-08-11']), arrivedElsewhere.deps);
  const line = arrivedElsewhere.lines.find((l) => l.includes('event=DAY_LOCAL_EVIDENCE')) ?? '';
  assert.ok(line.includes('localRowsScanned=1204'));
  assert.ok(line.includes('localUnresolvedOccurrence=1204'));
});

// --- 2: a missing row is a result -----------------------------------------------

test('2. a date with no stored row is named MISSING, never skipped', async () => {
  const h = harness((d) => (d === '2026-08-12' ? null : dayView({ businessDate: d })));
  const result = await runRead(request(OUTAGE), h.deps);
  assert.deepEqual(result.missing, ['2026-08-12']);
  assert.deepEqual(result.found, ['2026-08-11', '2026-08-13']);
  assert.equal(result.dates.length, 3, 'every requested date has an entry');
  const missing = h.lines.find((l) => l.includes('businessDate=2026-08-12')) ?? '';
  assert.ok(missing.includes('rowFound=false'));
  assert.ok(missing.includes('result=MISSING'));
  // And the summary says so too, by name.
  const summary = h.lines.find((l) => l.includes('event=READ_COMPLETE')) ?? '';
  assert.ok(summary.includes('MISSING_DATES=2026-08-12'));
  assert.ok(summary.includes('FOUND_DATES=2026-08-11,2026-08-13'));
  assert.ok(summary.includes('REQUESTED_DATES=2026-08-11,2026-08-12,2026-08-13'));
  assert.ok(summary.includes('OVERALL_RESULT=READ'));
});

test('2b. a finding is not a failure — every requested date missing is still a READ', async () => {
  const h = harness(() => null);
  const result = await runRead(request(OUTAGE), h.deps);
  assert.equal(result.overall, 'READ', 'inspection succeeded; the record is simply empty');
  assert.deepEqual(result.missing, OUTAGE);
  assert.deepEqual(result.found, []);
});

test('2c. an unreadable stored state is printed as-is, never guessed at', async () => {
  const h = harness(() => dayView({ state: null }));
  const result = await runRead(request(['2026-08-11']), h.deps);
  assert.equal(result.dates[0]!.state, null);
  assert.equal(result.dates[0]!.reconciled, false);
  assert.equal(result.dates[0]!.rowFound, true, 'the row exists even though its state does not read');
});

// --- 8, 9, 10: preconditions fail closed ----------------------------------------

test('8. an unknown organization fails closed, and no row is read', async () => {
  const h = harness(() => dayView(), null);
  const result = await runRead(request(OUTAGE), h.deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.equal(h.asked.length, 0);
});

test('9. a suspended or canceled organization is refused, following the operations convention', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const h = harness(() => dayView(), { ...ORG, status });
    const result = await runRead(request(OUTAGE), h.deps);
    assert.equal(result.overall, 'FAILED_PRECONDITION');
    assert.equal(h.asked.length, 0);
  }
});

test('9b. no dates is a precondition failure', async () => {
  const h = harness(() => dayView());
  const result = await runRead(request([]), h.deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.equal(h.asked.length, 0);
});

test('10. dates are validated with the shipped business-date predicate', () => {
  const parsed = parseDates(' 2026-08-11 , 2026-08-12,,08/13/2026 ');
  assert.deepEqual(parsed.dates, ['2026-08-11', '2026-08-12']);
  assert.deepEqual(parsed.invalid, ['08/13/2026']);
  assert.ok(RUNNER_SOURCE.includes('isBusinessDate'), 'the shipped predicate, not a local regex');
  assert.ok(!/\/\^\\d\{4\}/.test(RUNNER_SOURCE), 'no hand-rolled date pattern');
});

test('10b. flags parse in either spelling', () => {
  assert.deepEqual(parseArgs(['--organization', 'a', '--dates', '2026-08-11']), {
    organization: 'a',
    dates: '2026-08-11',
  });
  assert.deepEqual(parseArgs(['--org', 'a', '--date', '2026-08-11']), {
    organization: 'a',
    dates: '2026-08-11',
  });
});

// --- 5, 6, 7: the safety boundary ------------------------------------------------

test('5. no provider credential is required, or even named', () => {
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
  for (const secret of ['CALLGRID_API_KEY', 'CALLGRID_WEBHOOK_SECRET', 'apiKey', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY']) {
    assert.ok(!RUNNER_CODE.includes(secret), `the runner must not name ${secret}`);
  }
  assert.ok(!WORKFLOW_STEPS.includes('CALLGRID'), 'the workflow must not request a provider secret');
});

test('6. neither seam has a write method — mutation is not expressible', () => {
  // The seams are one organization lookup and one stored-row read. If a mutation
  // were ever added it would have to name a Prisma delegate directly, which the
  // next test forbids.
  assert.ok(RUNNER_SOURCE.includes('findDay('));
  assert.ok(RUNNER_SOURCE.includes('findBySlug('));
  for (const verb of ['recordDay(', 'create(', 'update(', 'upsert(', 'delete(', 'save(']) {
    assert.ok(!RUNNER_CODE.includes(verb), `the runner must not call ${verb}`);
  }
  // The one `write` in the file is `process.stdout.write`, which is the output.
  assert.ok(!/\.\s*write\(/.test(RUNNER_CODE.replace(/process\.stdout\.write\(/g, '')));
});

test('7. the runner names no reconciliation, certification, ingestion, recovery or declaration machinery', () => {
  for (const symbol of [
    'reconcileDay',
    'ProviderReconciliationService',
    'certifyDay',
    'ProviderObservationService',
    'IngestionService',
    'ingest(',
    'NormalizationEngine',
    'recover',
    'backfill',
    'replay',
    'CallGridReconciliationService',
    'declare',
    'registerSource',
    'declareAuthority',
    'correctMeasureDefinition',
    'assessReadiness',
    'measureChange',
    'Headline',
    'SourceOutcomeDay',
    'MarketplaceCall',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not name ${symbol}`);
  }
  // 'sync' as a word, not as the tail of 'async'.
  assert.ok(!/\bsync\b/.test(RUNNER_CODE), 'the runner must not sync');
});

test('7b. no Prisma delegate, no raw SQL, no provider adapter, no fetch', () => {
  assert.ok(!/prisma\.\w+\./.test(RUNNER_CODE), 'persistence goes through the repository');
  assert.ok(!RUNNER_CODE.includes('$executeRaw'));
  assert.ok(!RUNNER_CODE.includes('$queryRaw'));
  assert.ok(!/\bSELECT\s|\bINSERT\s|\bUPDATE\s+\w+\s+SET\b/.test(RUNNER_CODE));
  assert.ok(!RUNNER_CODE.includes('getCallGridProvider'));
  assert.ok(!RUNNER_CODE.includes('fetch('));
  assert.ok(!RUNNER_CODE.includes('@emgloop/providers'));
});

test('7c. provider and stream are constants, not inputs', () => {
  assert.equal(PROVIDER, 'callgrid');
  assert.equal(STREAM, 'calls');
  assert.ok(!/--provider|--stream/.test(RUNNER_SOURCE));
  for (const f of ['provider:', 'stream:']) {
    assert.ok(!WORKFLOW_STEPS.includes(`      ${f}`), `the workflow must not offer ${f} as an input`);
  }
});

test('4. no call identity, label or PII can be printed', () => {
  // Member ids and expectation states are the organization's own configuration.
  // A call identity, a label or a payload is not, and none is reachable: the
  // stored view exposes counts and member facts, and the printed allowlist is
  // fixed in the source.
  for (const symbol of [
    'externalId:',
    'labelAtObservation',
    'payload',
    'caller',
    'fromNumber',
    'recordingUrl',
    'transcript',
    'identity=',
    'idHashes',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not print ${symbol}`);
  }
});

test('4b. a run over a day with members prints ids and declarations, and nothing else about them', async () => {
  const h = harness(() => dayView());
  await runRead(request(['2026-08-11']), h.deps);
  const member = h.lines.find((l) => l.includes('event=MEMBER_EVIDENCE')) ?? '';
  assert.ok(member.includes('member=campaign-fixture-a'));
  assert.ok(member.includes('expectation=EXPECTED'));
  assert.ok(member.includes('providerOnly=3908'));
  // The fixture's label must never reach the output.
  assert.ok(!h.lines.join('\n').includes('A Campaign'), 'a display label is never printed');
});

// --- 14: idempotence -------------------------------------------------------------

test('14. re-running produces the same result and writes nothing', async () => {
  const answer = (d: BusinessDate) => (d === '2026-08-12' ? null : dayView({ businessDate: d }));
  const first = harness(answer);
  const second = harness(answer);
  const a = await runRead(request(OUTAGE), first.deps);
  const b = await runRead(request(OUTAGE), second.deps);
  assert.deepEqual(a.found, b.found);
  assert.deepEqual(a.missing, b.missing);
  assert.deepEqual(first.lines, second.lines, 'byte-identical output');
  // Only reads were made, and every one was scoped to the resolved organization.
  assert.ok(first.asked.every((x) => x.organizationId === ORG.id));
  assert.ok(first.asked.every((x) => x.provider === PROVIDER && x.stream === STREAM));
});

test('14b. tenant scope comes from the resolved organization, never from an input', async () => {
  const h = harness(() => dayView());
  await runRead({ organizationSlug: ORG.slug, dates: ['2026-08-11'] }, h.deps);
  assert.equal(h.asked[0]!.organizationId, ORG.id);
  assert.ok(!/organizationId:\s*(request|args|input)\./.test(RUNNER_SOURCE));
  assert.ok(!/--organization-id|--org-id/.test(RUNNER_SOURCE));
});

// --- 11, 12, 13: the workflow ----------------------------------------------------

test('11. the workflow is human-started only', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `the workflow must not carry ${trigger.trim()}`);
  }
});

test('12. the workflow invokes this runner and no other', () => {
  assert.ok(WORKFLOW_SOURCE.includes('read:reconciliation-evidence'));
  for (const other of [
    'reconcile:provider-days',
    'certify:observation-days',
    'declare:member-expectations',
    'declare:source-authority',
    'register:measurement-source',
    'bootstrap:stage3',
    'migrate deploy',
  ]) {
    assert.ok(!WORKFLOW_SOURCE.includes(other), `the workflow must not invoke ${other}`);
  }
});

test('13. the safety suite runs BEFORE the database credential is used', () => {
  const proof = WORKFLOW_SOURCE.indexOf('test:operations');
  const read = WORKFLOW_SOURCE.indexOf('read:reconciliation-evidence');
  assert.ok(proof > 0 && proof < read, 'the safety suite must run before the read step');
});

test('13b. the workflow names its one secret and never echoes it', () => {
  assert.ok(WORKFLOW_SOURCE.includes('DIRECT_DATABASE_URL'));
  assert.ok(!/echo\s+"?\$\{?\{?\s*secrets\./.test(WORKFLOW_SOURCE));
  const runBodies = WORKFLOW_SOURCE.split(/\n\s+run: \|/).slice(1);
  for (const body of runBodies) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.ok(!/\$\{\{\s*inputs\./.test(step), 'no input may be interpolated into a run body');
  }
});

test('no organization, campaign or person is hard-coded', () => {
  for (const literal of [
    'servicesinmycity',
    'cmng68vp2001d06inikyf6zqh',
    'cmo93ju7606k306k1of3tttac',
    'cmo1siqoq033t07jngw973suv',
    'cmphdtnu504eh07ii5aul38mz',
    '@elitemediagroup',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(literal), `the runner must not hard-code ${literal}`);
    assert.ok(!WORKFLOW_SOURCE.includes(literal), `the workflow must not hard-code ${literal}`);
  }
});
