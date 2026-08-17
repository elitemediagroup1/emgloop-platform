// The certification runner's orchestration.
//
// WHAT THESE PROVE
//
// Not whether a day is observed — that is `certifyDay`'s job and is tested in
// @emgloop/database. These prove the things the RUNNER is responsible for, each
// of which could silently produce a wrong sweep:
//
//   • dates are processed one at a time, in the order the operator supplied
//   • the run stops on the first day it cannot certify, and leaves the rest alone
//   • "we recorded a failure row" is never counted as a certified day
//   • the certify/stop decision is `certifiesObservation`, not a hard-coded list
//   • a missing credential or a bad organization fails before any provider call
//   • no credential value reaches a log line
//   • the runner cannot reach ingestion or projection at all
//
// The certifier is a double that returns canned evidence. That is deliberate and
// is not mocking away the behaviour under test: the orchestration IS the
// behaviour under test, and a double is the only way to drive a truncated day or
// an endpoint failure without a live provider outage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PROVIDER_OBSERVATION_STATUSES,
  certifiesObservation,
  type BusinessDate,
  type ProviderObservationStatus,
} from '@emgloop/shared';

import {
  parseArgs,
  parseDates,
  readEnvironment,
  runSweep,
  REFUSED_ORGANIZATION_STATUSES,
  type DayCertifier,
  type OrganizationLookup,
  type SweepDeps,
} from './certify-observation-days';

const ORG = { id: 'org_alpha', slug: 'servicesinmycity-demo', name: 'ServicesInMyCity', status: 'ACTIVE' };
const KEY = 'cg_live_not_a_real_secret_9f3a';

function organizations(row: typeof ORG | null = ORG): OrganizationLookup {
  return { async findBySlug() { return row; } };
}

/**
 * A certifier that answers with a scripted status per date and RECORDS which
 * dates it was actually asked about — which is how "it stopped" is proven, as
 * opposed to "it continued but ignored the results".
 */
function certifier(byDate: Record<string, ProviderObservationStatus>) {
  const asked: BusinessDate[] = [];
  const impl: DayCertifier = {
    async certifyDay({ businessDate }) {
      asked.push(businessDate);
      const status = byDate[businessDate] ?? 'SUCCESS';
      return {
        businessDate,
        timezone: 'America/New_York',
        status,
        observedAt: '2026-08-17T18:00:00.000Z',
        source: 'provider-query',
        recordsObserved: status === 'EMPTY' ? 0 : 900,
        providerStatedTotal: null,
        pagesFetched: status === 'EMPTY' ? 1 : 9,
        pageCap: 100,
        truncated: status === 'PARTIAL_PAGINATION',
        reason: status === 'PARTIAL_PAGINATION' ? 'Stopped at the 100-page budget.' : null,
      };
    },
  };
  return { impl, asked };
}

function deps(certify: DayCertifier, orgs: OrganizationLookup = organizations()) {
  const lines: string[] = [];
  let tick = 0;
  const d: SweepDeps = {
    certifier: certify,
    organizations: orgs,
    log: (l) => lines.push(l),
    now: () => new Date(Date.UTC(2026, 7, 17, 18, 0, ++tick)),
  };
  return { d, lines };
}

const THREE: BusinessDate[] = ['2026-08-03', '2026-08-04', '2026-08-05'];

// --- 1. Date validation ----------------------------------------------------------

test('a well-formed business date is accepted and a malformed one is rejected', () => {
  const ok = parseDates('2026-08-03,2026-08-04');
  assert.deepEqual(ok.dates, ['2026-08-03', '2026-08-04']);
  assert.deepEqual(ok.invalid, []);

  // Rejected rather than coerced. A date this tool cannot read is an operator
  // error, and guessing would point a production write at a day nobody asked for.
  for (const bad of ['3/8/2026', '2026-8-3', '20260803', 'yesterday', '2026-08-03T00:00:00Z', '--all']) {
    const parsed = parseDates(bad);
    assert.deepEqual(parsed.dates, [], `${bad} must not parse`);
    assert.deepEqual(parsed.invalid, [bad]);
  }
});

test('whitespace and empty segments are normalised, not rejected', () => {
  const parsed = parseDates('  2026-08-03 , ,\n2026-08-04,  ');
  assert.deepEqual(parsed.dates, ['2026-08-03', '2026-08-04']);
  assert.deepEqual(parsed.invalid, []);
});

test('a shell fragment in the dates input is an invalid date, never a command', () => {
  // The value only ever becomes an array of validated strings; it is never
  // interpolated into a shell. This asserts the parse side of that.
  const parsed = parseDates('2026-08-03; rm -rf /,$(whoami),`id`');
  assert.deepEqual(parsed.dates, []);
  assert.equal(parsed.invalid.length, 3);
});

test('flags are parsed without a CLI framework, and both spellings work', () => {
  assert.deepEqual(parseArgs(['--organization', 'acme', '--dates', '2026-08-03']), {
    organization: 'acme', dates: '2026-08-03',
  });
  assert.deepEqual(parseArgs(['--org', 'acme', '--date', '2026-08-03']), {
    organization: 'acme', dates: '2026-08-03',
  });
  assert.deepEqual(parseArgs([]), { organization: '', dates: '' });
});

// --- 2. Sequential, in the supplied order ----------------------------------------

test('dates are certified one at a time, in exactly the order supplied', async () => {
  const c = certifier({});
  const { d } = deps(c.impl);
  const out = await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);

  assert.deepEqual(c.asked, THREE, 'order is the operator\'s, not sorted or reversed');
  assert.deepEqual(out.outcomes.map((o) => o.businessDate), THREE);
  assert.equal(out.overall, 'SUCCESS');
});

test('an unsorted request is honoured as given rather than quietly reordered', async () => {
  const requested: BusinessDate[] = ['2026-08-09', '2026-08-03', '2026-08-16'];
  const c = certifier({});
  const { d } = deps(c.impl);
  await runSweep({ organizationSlug: ORG.slug, dates: requested, apiKey: KEY }, d);
  assert.deepEqual(c.asked, requested);
});

// --- 3-4. Certifying outcomes continue -------------------------------------------

test('SUCCESS continues to the next date', async () => {
  const c = certifier({ '2026-08-03': 'SUCCESS', '2026-08-04': 'SUCCESS', '2026-08-05': 'SUCCESS' });
  const { d } = deps(c.impl);
  const out = await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);
  assert.equal(out.overall, 'SUCCESS');
  assert.deepEqual(out.certified, THREE);
  assert.deepEqual(out.empty, []);
});

test('EMPTY continues — a proven zero is a certified day', async () => {
  const c = certifier({ '2026-08-04': 'EMPTY' });
  const { d } = deps(c.impl);
  const out = await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);
  assert.equal(out.overall, 'SUCCESS');
  assert.deepEqual(out.certified, THREE, 'EMPTY is certified, not skipped');
  assert.deepEqual(out.empty, ['2026-08-04'], 'and it is reported distinctly');
});

// --- 5-6. Non-certifying outcomes stop the run -----------------------------------

test('PARTIAL_PAGINATION stops the run and leaves later dates untouched', async () => {
  const c = certifier({ '2026-08-04': 'PARTIAL_PAGINATION' });
  const { d } = deps(c.impl);
  const out = await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);

  assert.equal(out.overall, 'STOPPED_NON_CERTIFYING');
  assert.equal(out.failedDate, '2026-08-04');
  assert.deepEqual(c.asked, ['2026-08-03', '2026-08-04'], '08-05 was never asked about');
  assert.deepEqual(out.certified, ['2026-08-03']);
});

test('ENDPOINT_FAILURE stops the run and leaves later dates untouched', async () => {
  const c = certifier({ '2026-08-03': 'ENDPOINT_FAILURE' });
  const { d } = deps(c.impl);
  const out = await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);

  assert.equal(out.overall, 'STOPPED_NON_CERTIFYING');
  assert.equal(out.failedDate, '2026-08-03');
  assert.deepEqual(c.asked, ['2026-08-03'], 'it stopped at the very first date');
  assert.deepEqual(out.certified, []);
});

test('a recorded failure row is never counted as a certified day', async () => {
  // certifyDay writes a row for a failure too — "we tried and could not finish"
  // is worth keeping. The runner must not read that successful WRITE as a
  // successful CERTIFICATION.
  const c = certifier({ '2026-08-03': 'ENDPOINT_FAILURE' });
  const { d, lines } = deps(c.impl);
  const out = await runSweep({ organizationSlug: ORG.slug, dates: ['2026-08-03'], apiKey: KEY }, d);

  assert.equal(out.certified.length, 0);
  assert.equal(out.empty.length, 0);
  assert.ok(lines.some((l) => l.includes('certifies=NO')));
  assert.ok(lines.some((l) => l.includes('OVERALL_RESULT=STOPPED_NON_CERTIFYING')));
});

test('a certifier that throws stops the run rather than inventing a status', async () => {
  const impl: DayCertifier = {
    async certifyDay() { throw new Error('connection terminated unexpectedly'); },
  };
  const { d, lines } = deps(impl);
  const out = await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);

  assert.equal(out.overall, 'STOPPED_NON_CERTIFYING');
  assert.equal(out.failedDate, '2026-08-03');
  assert.equal(out.outcomes.length, 0, 'no outcome is fabricated for a call that never returned');
  assert.ok(lines.some((l) => l.includes('event=DAY_ERROR')));
});

// --- 7. The decision is the shared rule, not a local list -------------------------

test('every status is judged by certifiesObservation, including ones added later', async () => {
  // If a seventh status is added tomorrow, this runner handles it correctly on
  // the day it is added — because it asks the shared rule rather than checking a
  // list of today's failures.
  for (const status of PROVIDER_OBSERVATION_STATUSES) {
    const c = certifier({ '2026-08-03': status });
    const { d } = deps(c.impl);
    const out = await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);

    if (certifiesObservation(status)) {
      assert.equal(out.overall, 'SUCCESS', `${status} certifies, so the sweep continues`);
      assert.deepEqual(c.asked, THREE);
    } else {
      assert.equal(out.overall, 'STOPPED_NON_CERTIFYING', `${status} does not certify, so it stops`);
      assert.deepEqual(c.asked, ['2026-08-03']);
    }
  }
});

test('the runner does not hard-code the set of failing statuses', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'certify-observation-days.ts'),
    'utf8',
  );
  for (const status of ['PARTIAL_PAGINATION', 'ENDPOINT_FAILURE', 'MALFORMED_RESPONSE', 'UNKNOWN_ENVELOPE']) {
    assert.ok(
      !source.includes(`'${status}'`),
      `${status} must not appear as a literal — the decision belongs to certifiesObservation`,
    );
  }
});

// --- 8. Organization resolution fails closed --------------------------------------

test('an unknown organization slug stops before any certification', async () => {
  const c = certifier({});
  const { d, lines } = deps(c.impl, organizations(null));
  const out = await runSweep({ organizationSlug: 'not-a-tenant', dates: THREE, apiKey: KEY }, d);

  assert.equal(out.overall, 'FAILED_PRECONDITION');
  assert.equal(c.asked.length, 0, 'the provider was never contacted');
  assert.ok(lines.some((l) => l.includes('event=PRECONDITION_FAILED')));
});

test('a suspended or cancelled organization is refused', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const c = certifier({});
    const { d } = deps(c.impl, organizations({ ...ORG, status }));
    const out = await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);
    assert.equal(out.overall, 'FAILED_PRECONDITION', `${status} must be refused`);
    assert.equal(c.asked.length, 0);
  }
});

test('an ordinary non-ACTIVE status is not refused', async () => {
  // TRIAL and PAST_DUE are normal states in this schema and the platform gates on
  // neither anywhere else. Refusing them here would invent a rule and would block
  // the live tenant for no reason.
  for (const status of ['TRIAL', 'PAST_DUE']) {
    const c = certifier({});
    const { d } = deps(c.impl, organizations({ ...ORG, status }));
    const out = await runSweep({ organizationSlug: ORG.slug, dates: ['2026-08-03'], apiKey: KEY }, d);
    assert.equal(out.overall, 'SUCCESS', `${status} is an ordinary tenant state`);
  }
});

test('no dates is a precondition failure, not an empty success', async () => {
  const c = certifier({});
  const { d } = deps(c.impl);
  const out = await runSweep({ organizationSlug: ORG.slug, dates: [], apiKey: KEY }, d);
  assert.equal(out.overall, 'FAILED_PRECONDITION');
  assert.equal(c.asked.length, 0);
});

// --- 9. Missing environment fails before the provider call ------------------------

test('a missing credential is reported by NAME and fails closed', () => {
  const none = readEnvironment({});
  assert.equal(none.ok, false);
  assert.deepEqual(none.ok === false ? none.missing.sort() : [], ['CALLGRID_API_KEY', 'DATABASE_URL']);

  const noKey = readEnvironment({ DATABASE_URL: 'postgresql://x' });
  assert.equal(noKey.ok, false);
  assert.deepEqual(noKey.ok === false ? noKey.missing : [], ['CALLGRID_API_KEY']);

  const noDb = readEnvironment({ CALLGRID_API_KEY: KEY });
  assert.equal(noDb.ok, false);
  assert.deepEqual(noDb.ok === false ? noDb.missing : [], ['DATABASE_URL']);
});

test('a whitespace-only credential counts as missing', () => {
  const blank = readEnvironment({ DATABASE_URL: '   ', CALLGRID_API_KEY: '\t' });
  assert.equal(blank.ok, false);
  assert.deepEqual(blank.ok === false ? blank.missing.sort() : [], ['CALLGRID_API_KEY', 'DATABASE_URL']);
});

test('a complete environment resolves without echoing anything', () => {
  const env = readEnvironment({ DATABASE_URL: 'postgresql://user:pw@host/db', CALLGRID_API_KEY: KEY });
  assert.equal(env.ok, true);
  // The values ARE returned to the caller that needs them; what must never happen
  // is a value appearing in a log line, which the next test proves.
  assert.equal(env.ok === true ? env.value.apiKey : '', KEY);
});

// --- 10. Nothing secret reaches a log ---------------------------------------------

test('no log line contains the API key, a connection string or a caller number', async () => {
  const c = certifier({ '2026-08-04': 'PARTIAL_PAGINATION' });
  const { d, lines } = deps(c.impl);
  await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);

  const all = lines.join('\n');
  assert.ok(lines.length > 0, 'the run logged something');
  for (const secret of [KEY, 'not_a_real_secret', 'postgresql://', 'Bearer ', '+1212555']) {
    assert.ok(!all.includes(secret), `a log line leaked ${secret}`);
  }
});

test('the summary reports every field an operator needs to read the run', async () => {
  const c = certifier({ '2026-08-04': 'EMPTY' });
  const { d, lines } = deps(c.impl);
  await runSweep({ organizationSlug: ORG.slug, dates: THREE, apiKey: KEY }, d);

  const summary = lines.find((l) => l.startsWith('event=SUMMARY'));
  assert.ok(summary, 'a summary is always printed');
  for (const field of ['REQUESTED_DATES=', 'CERTIFIED_DATES=', 'EMPTY_DATES=', 'FAILED_DATE=', 'OVERALL_RESULT=']) {
    assert.ok(summary!.includes(field), `summary must state ${field}`);
  }
});

test('each day reports the evidence the ledger persisted', async () => {
  const c = certifier({});
  const { d, lines } = deps(c.impl);
  await runSweep({ organizationSlug: ORG.slug, dates: ['2026-08-03'], apiKey: KEY }, d);

  const day = lines.find((l) => l.startsWith('event=DAY_RESULT'))!;
  for (const field of [
    'date=', 'status=', 'certifies=', 'records=', 'providerStatedTotal=', 'pages=',
    'pageCap=', 'truncated=', 'timezone=', 'observedAt=', 'source=', 'ledgerRow=', 'durationMs=',
  ]) {
    assert.ok(day.includes(field), `day line must state ${field}`);
  }
  // The persisted identity is the natural key the upsert targets.
  assert.ok(day.includes(`ledgerRow=${ORG.slug}/callgrid/calls/2026-08-03`));
});

// --- 11. The runner cannot reach recovery -----------------------------------------

test('the runner references no ingestion, projection or measurement machinery', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'certify-observation-days.ts'),
    'utf8',
  );
  // A static assertion, deliberately: this is the guard that makes accidental
  // scope expansion visible at review time rather than in production. Adding any
  // of these to this file breaks the build of the test suite, which is the point.
  const forbidden = [
    'IngestionService',
    'MarketplaceCall',
    'projectInteraction',
    'projectWindow',
    'HeadlineDetectionService',
    'CommercialSignal',
    'ObjectiveMeasureBinding',
    'OperationalPriority',
    'ensureLiveOrganization',
    'CallGridReconciliationService',
    'interaction.',
    'createUser',
  ];
  for (const symbol of forbidden) {
    assert.ok(!source.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner has exactly one production write path, and it is certifyDay', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'certify-observation-days.ts'),
    'utf8',
  );
  // No model delegate is reachable from here: everything that touches a row goes
  // through an injected seam. `prisma.$disconnect()` is deliberately allowed and
  // deliberately not matched — closing the connection this script opened is
  // hygiene, not data access — so the pattern targets `prisma.<model>` rather
  // than the client itself.
  assert.equal(
    /prisma\.[a-z]/.test(source), false,
    'the runner must not reach a Prisma model delegate',
  );
  for (const verb of ['.create(', '.update(', '.upsert(', '.delete(', '$executeRaw', '$queryRaw']) {
    assert.ok(!source.includes(verb), `the runner must not call ${verb} directly`);
  }
  assert.ok(source.includes('certifyDay('), 'certification is invoked, not reimplemented');
});

test('the runner computes no day boundary, pagination or status of its own', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'certify-observation-days.ts'),
    'utf8',
  );
  for (const symbol of [
    'easternBusinessDayWindow',   // the day boundary belongs to certifyDay
    'fetchAllCallGridCalls',      // pagination belongs to the adapter
    'fetchCallGridCallsPage',
    'getCallGridProvider',
    'recordDay',                  // the ledger write belongs to the repository
    'windowStart',
    'maxPages',
  ]) {
    assert.ok(!source.includes(symbol), `the runner must not touch ${symbol}`);
  }
});

// --- 12. Rerun safety -------------------------------------------------------------

test('rerunning the same date calls certifyDay again rather than skipping it', async () => {
  // Idempotency belongs to the ledger upsert, not to this runner. Skipping a date
  // because a row exists would add a SECOND idempotency mechanism and would make
  // re-certifying a previously failed day impossible — which is exactly the
  // operation an operator needs after fixing a provider problem.
  const c = certifier({});
  const { d } = deps(c.impl);
  await runSweep({ organizationSlug: ORG.slug, dates: ['2026-08-03'], apiKey: KEY }, d);
  await runSweep({ organizationSlug: ORG.slug, dates: ['2026-08-03'], apiKey: KEY }, d);
  assert.deepEqual(c.asked, ['2026-08-03', '2026-08-03'], 'both runs asked');
});

test('importing the module does not start a sweep or set an exit code', () => {
  // The entry-point guard is anchored to this script's exact filename. It was
  // briefly a substring check, and because THIS file's name contains that
  // substring, importing it ran main(), failed preconditions and set
  // process.exitCode — every test passed and the suite still failed. If that
  // regresses, this assertion is what says so.
  assert.notEqual(process.exitCode, 2, 'main() must not have run on import');
  assert.ok(!process.exitCode, 'importing the runner is inert');
});

test('a date repeated within one request is certified once per occurrence', async () => {
  const c = certifier({});
  const { d } = deps(c.impl);
  const out = await runSweep(
    { organizationSlug: ORG.slug, dates: ['2026-08-03', '2026-08-03'], apiKey: KEY },
    d,
  );
  // Not deduplicated: the upsert makes it harmless, and silently dropping an
  // operator's input is worse than doing what they asked.
  assert.deepEqual(c.asked, ['2026-08-03', '2026-08-03']);
  assert.equal(out.overall, 'SUCCESS');
});
