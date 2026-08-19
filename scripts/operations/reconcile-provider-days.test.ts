// The reconciliation runner — behaviour, and what it is structurally unable to do.
//
// TWO KINDS OF TEST LIVE HERE, DELIBERATELY.
//
// The behavioural ones drive `runSweep` through injected seams: what it does with
// a day that reconciles, one that does not, one whose comparison contradicted
// itself, an organization that does not exist, and a date it cannot parse.
//
// The source-constraint ones read this runner's own source and fail if it ever
// names ingestion, projection, recovery, measurement, certification, declaration
// or a Prisma delegate. They are the guard that makes accidental scope expansion
// visible at review time rather than in production — a comment saying "read-only"
// is not a property, and this is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECONCILIATION_STATES, reconciliationCertifies, type BusinessDate } from '@emgloop/shared';
import type { ReconciliationDayView } from '@emgloop/database';

import {
  REFUSED_ORGANIZATION_STATUSES,
  parseArgs,
  parseDates,
  readEnvironment,
  runSweep,
  type DayReconciler,
  type OrganizationLookup,
  type SweepDeps,
} from './reconcile-provider-days';

const RUNNER_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'reconcile-provider-days.ts'),
  'utf8',
);

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };

function dayView(over: Partial<ReconciliationDayView> = {}): ReconciliationDayView {
  return {
    businessDate: '2026-08-05',
    timezone: 'America/New_York',
    state: 'RECONCILED',
    ruleVersion: 'provider-reconciliation.v1',
    localStage: 'integration_event',
    counts: {
      providerUnique: 10,
      providerDuplicateIds: 0,
      localUnique: 10,
      localDuplicateIds: 0,
      intersection: 10,
      providerOnly: 0,
      localOnly: 0,
      providerOnlyExpected: 0,
      providerOnlyNotConfigured: 0,
      providerOnlyExcluded: 0,
      providerOnlyUnknownMember: 0,
    },
    evidence: {
      providerRecords: 10,
      providerUnattributed: 0,
      localRowsScanned: 10,
      localInWindow: 10,
      localUnresolvedOccurrence: 0,
      localMissingIdentity: 0,
      pagesFetched: 1,
      pageCap: 100,
      truncated: false,
    },
    reason: null,
    observedAt: '2026-08-19T12:00:00.000Z',
    reconciledAt: '2026-08-19T12:00:00.000Z',
    members: [],
    ...over,
  };
}

interface Recorder {
  lines: string[];
  asked: BusinessDate[];
  deps: SweepDeps;
}

function recorder(
  answer: (date: BusinessDate) => Awaited<ReturnType<DayReconciler['reconcileDay']>>,
  organization: { id: string; slug: string; name: string; status: string } | null = ORG,
): Recorder {
  const lines: string[] = [];
  const asked: BusinessDate[] = [];
  let tick = 0;
  const organizations: OrganizationLookup = {
    async findBySlug() {
      return organization;
    },
  };
  const reconciler: DayReconciler = {
    async reconcileDay(input) {
      asked.push(input.businessDate);
      return answer(input.businessDate);
    },
  };
  return {
    lines,
    asked,
    deps: {
      reconciler,
      organizations,
      log: (l) => lines.push(l),
      now: () => new Date(Date.UTC(2026, 7, 19, 12, 0, ++tick)),
    },
  };
}

const request = (dates: BusinessDate[]) => ({
  organizationSlug: ORG.slug,
  dates,
  apiKey: 'test-key',
});

// --- Behaviour ----------------------------------------------------------------

test('a reconciled day is a green run', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }));
  const result = await runSweep(request(['2026-08-05']), r.deps);
  assert.equal(result.overall, 'SUCCESS');
  assert.deepEqual(result.reconciled, ['2026-08-05']);
  assert.equal(result.failedDate, null);
});

test('a day that did not reconcile stops the sweep and leaves later dates untouched', async () => {
  const r = recorder((date) =>
    date === '2026-08-05'
      ? { ok: true as const, day: dayView({ state: 'UNRECONCILED', businessDate: date }) }
      : { ok: true as const, day: dayView({ businessDate: date }) },
  );
  const result = await runSweep(request(['2026-08-05', '2026-08-06', '2026-08-07']), r.deps);
  assert.equal(result.overall, 'STOPPED_NOT_RECONCILED');
  assert.equal(result.failedDate, '2026-08-05');
  // The later dates were never asked about. A sweep that carried on would leave
  // a table full of rows and a false sense the window was worked through.
  assert.deepEqual(r.asked, ['2026-08-05']);
});

test('a recorded non-reconciliation is a successful WRITE and NOT a reconciled day', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView({ state: 'UNKNOWN_EXPECTATION' }) }));
  const result = await runSweep(request(['2026-08-05']), r.deps);
  assert.equal(result.overall, 'STOPPED_NOT_RECONCILED');
  const day = r.lines.find((l) => l.startsWith('event=DAY_RESULT'));
  assert.match(String(day), /written=true/);
  assert.match(String(day), /reconciled=false/);
});

test('a comparison that contradicted itself is a DIFFERENT failure, and nothing was written', async () => {
  const r = recorder(() => ({
    ok: false as const,
    reason: 'DIAGNOSTIC_DEFECT',
    problems: ['intersection + providerOnly !== providerUnique'],
  }));
  const result = await runSweep(request(['2026-08-05', '2026-08-06']), r.deps);
  assert.equal(result.overall, 'DIAGNOSTIC_DEFECT');
  assert.deepEqual(r.asked, ['2026-08-05']);
  const day = r.lines.find((l) => l.startsWith('event=DAY_RESULT'));
  assert.match(String(day), /written=false/);
  assert.match(String(day), /state=REFUSED/);
});

test('every reconciliation state is judged by reconciliationCertifies, not by a local list', async () => {
  // A fifth state added later is handled correctly on the day it is added,
  // because this runner asks the shared predicate rather than naming states.
  for (const state of RECONCILIATION_STATES) {
    const r = recorder(() => ({ ok: true as const, day: dayView({ state }) }));
    const result = await runSweep(request(['2026-08-05']), r.deps);
    assert.equal(
      result.overall === 'SUCCESS',
      reconciliationCertifies(state),
      `${state} must stop the sweep exactly when it does not certify`,
    );
  }
});

test('dates are reconciled sequentially, in the order supplied', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }));
  await runSweep(request(['2026-08-05', '2026-08-06', '2026-08-07']), r.deps);
  assert.deepEqual(r.asked, ['2026-08-05', '2026-08-06', '2026-08-07']);
});

test('an unknown organization is a precondition failure, and nothing is reconciled', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }), null);
  const result = await runSweep(request(['2026-08-05']), r.deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.deepEqual(r.asked, []);
  assert.match(String(result.error), /No organization with slug/);
});

test('a suspended or cancelled organization is refused before any provider request', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const r = recorder(() => ({ ok: true as const, day: dayView() }), { ...ORG, status });
    const result = await runSweep(request(['2026-08-05']), r.deps);
    assert.equal(result.overall, 'FAILED_PRECONDITION');
    assert.deepEqual(r.asked, []);
  }
});

test('an ordinary non-ACTIVE status is accepted — TRIAL is not a reason to refuse', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }), { ...ORG, status: 'TRIAL' });
  const result = await runSweep(request(['2026-08-05']), r.deps);
  assert.equal(result.overall, 'SUCCESS');
});

test('no dates supplied is a precondition failure', async () => {
  const r = recorder(() => ({ ok: true as const, day: dayView() }));
  const result = await runSweep(request([]), r.deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.deepEqual(r.asked, []);
});

test('member lines carry the member id and its expectation, and never a call identity', async () => {
  const r = recorder(() => ({
    ok: true as const,
    day: dayView({
      members: [
        {
          dimension: 'CAMPAIGN',
          memberExternalId: 'cmp-1',
          providerCount: 10,
          providerOnly: 0,
          localCount: 10,
          localOnly: 0,
          expectationState: 'EXPECTED',
          expectationId: 'decl_1',
          expectationMatches: 1,
          labelAtObservation: 'A label',
        },
      ],
    }),
  }));
  await runSweep(request(['2026-08-05']), r.deps);
  const member = r.lines.find((l) => l.startsWith('event=MEMBER_RESULT'));
  assert.match(String(member), /member=cmp-1/);
  assert.match(String(member), /expectation=EXPECTED/);
});

test('rerunning the same date asks again rather than skipping it', async () => {
  // Idempotency belongs to the day upsert, not to this runner. Skipping a date
  // because a row exists would make re-reconciling after a fix impossible, which
  // is exactly the operation an operator needs.
  const r = recorder(() => ({ ok: true as const, day: dayView() }));
  await runSweep(request(['2026-08-05']), r.deps);
  await runSweep(request(['2026-08-05']), r.deps);
  assert.deepEqual(r.asked, ['2026-08-05', '2026-08-05']);
});

// --- Input handling -----------------------------------------------------------

test('dates are parsed with the same predicate the service applies', () => {
  assert.deepEqual(parseDates('2026-08-05').dates, ['2026-08-05']);
  assert.deepEqual(parseDates(' 2026-08-05 , 2026-08-06 ').dates, ['2026-08-05', '2026-08-06']);
  assert.deepEqual(parseDates('2026-08-05,,').dates, ['2026-08-05']);
  // Rejected, never coerced: guessing at a date would point a production write at
  // a day nobody asked for.
  assert.deepEqual(parseDates('05/08/2026').invalid, ['05/08/2026']);
  assert.deepEqual(parseDates('2026-8-5').invalid, ['2026-8-5']);
  assert.deepEqual(parseDates('yesterday').invalid, ['yesterday']);
});

test('missing credentials are reported BY NAME, never by value', () => {
  const missing = readEnvironment({} as NodeJS.ProcessEnv);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.missing.sort(), ['CALLGRID_API_KEY', 'DATABASE_URL']);
  const present = readEnvironment({
    DATABASE_URL: 'postgres://x',
    CALLGRID_API_KEY: 'secret',
  } as NodeJS.ProcessEnv);
  assert.equal(present.ok, true);
});

test('flags parse in either spelling', () => {
  assert.deepEqual(parseArgs(['--organization', 'a', '--dates', '2026-08-05']), {
    organization: 'a',
    dates: '2026-08-05',
  });
  assert.deepEqual(parseArgs(['--org', 'a', '--date', '2026-08-05']), {
    organization: 'a',
    dates: '2026-08-05',
  });
});

// --- Source constraints -------------------------------------------------------

test('the runner references no ingestion, projection, recovery or measurement machinery', () => {
  // A static assertion, deliberately: adding any of these to that file breaks
  // this suite, which is the point. "It observes and records" becomes a checked
  // property rather than a claim in a header.
  const forbidden = [
    'IngestionService',
    'NormalizationEngine',
    'MarketplaceCall',
    'projectInteraction',
    'projectWindow',
    'CallGridReconciliationService',
    'HeadlineDetectionService',
    'CommercialSignal',
    'ObjectiveMeasureBinding',
    'OperationalPriority',
    'ensureLiveOrganization',
    'createUser',
    'interaction.',
  ];
  for (const symbol of forbidden) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner cannot certify a day or declare an expectation', () => {
  // Reconciliation observes. Certification is a different fact with a different
  // write, and expectation is a HUMAN statement that no automated run may make.
  for (const symbol of [
    'certifyDay',
    'ProviderObservationService',
    'ProviderObservationRepository',
    'recordDay',
    'declare(',
    'ProviderMemberExpectationRepository',
    'DeclareExpectationInput',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reach ${symbol}`);
  }
});

test('the runner has exactly one production write path, and it is reconcileDay', () => {
  // `prisma.$disconnect()` is deliberately allowed and deliberately not matched
  // — closing the connection this script opened is hygiene, not data access —
  // so the pattern targets `prisma.<model>` rather than the client itself.
  assert.equal(
    /prisma\.[a-z]/.test(RUNNER_SOURCE),
    false,
    'the runner must not reach a Prisma model delegate',
  );
  for (const verb of ['.create(', '.update(', '.upsert(', '.delete(', '.deleteMany(', '$executeRaw', '$queryRaw']) {
    assert.ok(!RUNNER_SOURCE.includes(verb), `the runner must not call ${verb} directly`);
  }
  assert.ok(RUNNER_SOURCE.includes('reconcileDay('), 'reconciliation is invoked, not reimplemented');
});

test('the runner computes no window, pagination, occurrence or verdict of its own', () => {
  for (const symbol of [
    'easternBusinessDayWindow',   // the day boundary belongs to the service
    'resolveCallOccurrence',      // occurrence belongs to the canonical resolver
    'getCallGridProvider',        // the provider read belongs to the adapter
    'fetchAllCallGridCalls',
    'maxPages',
    'listEventsReceivedBetween',  // the local read belongs to the service's seam
    'normalizeExternalIdentity',  // identity normalisation belongs to shared
    'deriveReconciliationState',  // the verdict belongs to the pure contract
    'assessReconciliation',
    'countProblems',
    'windowStart',
    'campaignId',                 // member attribution belongs to the service
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not touch ${symbol}`);
  }
});

test('the runner never emits a raw call identity', () => {
  // Member ids and expectation states are the organization's own configuration
  // and are safe to print. A CALL identity is not, and there is no code path
  // here that reaches one: the day view exposes counts and member facts only.
  for (const symbol of ['externalId', 'identity=', 'providerOnlyIds', 'hashIdentity', 'idHashes']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not print ${symbol}`);
  }
  // And nothing PII-shaped can reach it either, since it never reads a payload.
  for (const symbol of ['payload', 'caller', 'fromNumber', 'recordingUrl', 'transcript']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner has no schedule of its own and no parallelism', () => {
  // A parallel sweep cannot stop at the first day that fails, because by then it
  // has already worked through the others.
  assert.equal(RUNNER_SOURCE.includes('Promise.all'), false);
  assert.equal(RUNNER_SOURCE.includes('Promise.allSettled'), false);
  assert.equal(RUNNER_SOURCE.includes('setInterval'), false);
});

// --- The workflow that invokes it ---------------------------------------------
//
// A runner with no way to be started is a runner that does not exist -- the
// defect PR #163 found in `certifyDay`, which shipped with no caller at all.
// These assert the trigger exists AND that it is the only kind of trigger there.

const WORKFLOW_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'reconcile-provider-days.yml'),
  'utf8',
);

test('the workflow exists and invokes this runner', () => {
  assert.match(WORKFLOW_SOURCE, /npm run reconcile:provider-days/);
  assert.match(WORKFLOW_SOURCE, /--organization/);
  assert.match(WORKFLOW_SOURCE, /--dates/);
});

test('the workflow is human-started only — no schedule, no push, no pull_request', () => {
  assert.match(WORKFLOW_SOURCE, /workflow_dispatch:/);
  // A `cron:` here would automate an operation nobody has yet run once by hand.
  assert.equal(/^\s{0,4}schedule:/m.test(WORKFLOW_SOURCE), false, 'no schedule trigger');
  assert.equal(/^\s{0,4}push:/m.test(WORKFLOW_SOURCE), false, 'no push trigger');
  assert.equal(/^\s{0,4}pull_request:/m.test(WORKFLOW_SOURCE), false, 'no pull_request trigger');
  assert.equal(WORKFLOW_SOURCE.includes('cron:'), false, 'no cron');
});

test('the workflow proves the write boundary BEFORE it touches production', () => {
  const safety = WORKFLOW_SOURCE.indexOf('npm run test:operations');
  const production = WORKFLOW_SOURCE.indexOf('npm run reconcile:provider-days');
  assert.ok(safety > 0, 'the safety suite runs');
  assert.ok(production > 0, 'the reconciliation runs');
  assert.ok(
    safety < production,
    'the constraint tests must run before the production credential is used, or they prove nothing about this run',
  );
});

test('the workflow requires both production secrets and names them without printing values', () => {
  assert.match(WORKFLOW_SOURCE, /DIRECT_DATABASE_URL/);
  assert.match(WORKFLOW_SOURCE, /CALLGRID_API_KEY/);
  assert.match(WORKFLOW_SOURCE, /Missing repository secret/);
  // The secret VALUES must only ever reach `env:`, never an `echo`.
  assert.equal(/echo[^\n]*\$\{\{\s*secrets\./.test(WORKFLOW_SOURCE), false);
});

test('the workflow serialises runs against itself', () => {
  assert.match(WORKFLOW_SOURCE, /concurrency:/);
  assert.match(WORKFLOW_SOURCE, /cancel-in-progress:\s*false/);
});
