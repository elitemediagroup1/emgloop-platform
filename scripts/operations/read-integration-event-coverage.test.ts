// Tests for the integration event coverage reader.
//
// WHAT THESE PROVE
//
// Two properties carry the weight. First, that the aggregation is honest: a call
// that occurred on one date and was delivered on another lands in the right
// bucket in all three views at once, which is the entire reason this tool exists.
// Second, that nothing else is possible — no write, no provider client, no
// payload value, no identity, no PII — proved by reading the runner's own source,
// because a comment saying "counts only" is not a property and those are.
//
// THE OCCURRENCE RESOLVER UNDER TEST IS THE REAL ONE. `resolveCallOccurrence` is
// imported from `@emgloop/providers` and injected, so these tests exercise the
// canonical field precedence rather than a convenient stand-in. A second resolver
// written for the fixtures would agree with the first right up until it mattered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { easternBusinessDayWindow, type BusinessDate } from '@emgloop/shared';
import { resolveCallOccurrence } from '@emgloop/providers';

import {
  BATCH_SIZE,
  PROVIDER,
  REFUSED_ORGANIZATION_STATUSES,
  parseArgs,
  readEnvironment,
  runCoverage,
  validateRange,
  type CoverageDeps,
  type RawEventRow,
} from './read-integration-event-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = readFileSync(join(HERE, 'read-integration-event-coverage.ts'), 'utf8');
const WORKFLOW_SOURCE = readFileSync(
  join(HERE, '..', '..', '.github', 'workflows', 'read-integration-event-coverage.yml'),
  'utf8',
);

// Prose removed — line comments AND block-comment bodies. The "must not name"
// checks are about CODE, and a header sentence saying this job cannot import,
// or a doc block naming the dates under investigation, must not read as the code
// doing either.
const RUNNER_CODE = RUNNER_SOURCE.split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

/** The workflow with its `#` prose removed, for the same reason. */
const WORKFLOW_STEPS = WORKFLOW_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };

/** An Eastern instant inside the named business date, at noon local. */
function noonEastern(date: BusinessDate): Date {
  const w = easternBusinessDayWindow(date);
  return new Date(w.start.getTime() + 12 * 60 * 60 * 1000);
}

let seq = 0;
/**
 * One stored row.
 *
 * The payload carries `UTCUnixTimeMs`, the highest-fidelity field the canonical
 * resolver reads, plus fields a careless printer might leak — a caller number, a
 * campaign label and a name — so the PII assertions have something real to catch.
 */
function row(over: {
  occurredOn?: BusinessDate | null;
  receivedOn: BusinessDate;
  status?: string;
  externalId?: string | null;
}): RawEventRow {
  seq += 1;
  const occurred = over.occurredOn === undefined ? over.receivedOn : over.occurredOn;
  return {
    id: `evt_${String(seq).padStart(6, '0')}`,
    externalId: over.externalId === undefined ? `call-${seq}` : over.externalId,
    status: over.status ?? 'PROCESSED',
    receivedAt: noonEastern(over.receivedOn),
    payload: {
      ...(occurred ? { UTCUnixTimeMs: noonEastern(occurred).getTime() } : {}),
      callerId: '+15551234567',
      callerName: 'A Person',
      campaignName: 'Roofing - TX',
      email: 'someone@example.test',
    },
  };
}

interface Harness {
  lines: string[];
  asked: Array<{ organizationId: string; provider: string; since: Date; until: Date }>;
  deps: CoverageDeps;
}

function harness(
  rows: RawEventRow[],
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
      events: {
        async listEventsReceivedBetween(organizationId, options) {
          asked.push({
            organizationId,
            provider: options.provider,
            since: options.since,
            until: options.until,
          });
          // A real cursor, so the batching path is exercised rather than assumed.
          const after = options.afterId;
          const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
          const inRange = rows.filter(
            (r) => r.receivedAt >= options.since && r.receivedAt < options.until,
          );
          const from = after ? inRange.findIndex((r) => r.id === after) + 1 : start;
          return inRange.slice(from, from + (options.batchSize ?? BATCH_SIZE));
        },
      },
      // THE CANONICAL RESOLVER, not a fixture stand-in.
      resolveOccurrence: resolveCallOccurrence,
      log: (l) => lines.push(l),
    },
  };
}

const request = (from: BusinessDate, to: BusinessDate) => ({
  organizationSlug: ORG.slug,
  from,
  to,
});

const find = (lines: string[], event: string) => lines.filter((l) => l.includes(`event=${event}`));

// --- 1, 2, 3, 4: preconditions fail closed ---------------------------------------

test('1. an unknown organization fails closed, and no row is read', async () => {
  const h = harness([row({ receivedOn: '2026-08-11' })], null);
  const result = await runCoverage(request('2026-08-01', '2026-08-19'), h.deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.equal(h.asked.length, 0);
});

test('2. a suspended or canceled organization is refused before any read', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const h = harness([row({ receivedOn: '2026-08-11' })], { ...ORG, status });
    const result = await runCoverage(request('2026-08-01', '2026-08-19'), h.deps);
    assert.equal(result.overall, 'FAILED_PRECONDITION');
    assert.equal(h.asked.length, 0);
  }
});

test('3. invalid dates are refused before the organization is even resolved', async () => {
  for (const [from, to] of [
    ['08/01/2026', '2026-08-19'],
    ['2026-08-01', 'yesterday'],
    ['', ''],
  ]) {
    const h = harness([row({ receivedOn: '2026-08-11' })]);
    const result = await runCoverage(
      { organizationSlug: ORG.slug, from: from as BusinessDate, to: to as BusinessDate },
      h.deps,
    );
    assert.equal(result.overall, 'FAILED_PRECONDITION');
    assert.equal(h.asked.length, 0, 'nothing was read');
  }
});

test('4. an inverted range is refused, and an equal range is not', async () => {
  const inverted = validateRange('2026-08-19', '2026-08-01');
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.match(inverted.problems.join(' '), /INCLUSIVE/);

  // `to` is INCLUSIVE, so one day is a legitimate question.
  const single = validateRange('2026-08-11', '2026-08-11');
  assert.equal(single.ok, true);
  const h = harness([row({ receivedOn: '2026-08-11' })]);
  const result = await runCoverage(request('2026-08-11', '2026-08-11'), h.deps);
  assert.equal(result.overall, 'READ');
  assert.equal(result.totalRows, 1, 'a single-day range covers that whole Eastern day');
});

// --- 5: tenancy and the read contract --------------------------------------------

test('5. every read is scoped to the resolved organization and the fixed provider', async () => {
  const h = harness([row({ receivedOn: '2026-08-11' })]);
  await runCoverage(request('2026-08-01', '2026-08-19'), h.deps);
  assert.ok(h.asked.length > 0);
  assert.ok(h.asked.every((a) => a.organizationId === ORG.id));
  assert.ok(h.asked.every((a) => a.provider === PROVIDER));
  assert.equal(PROVIDER, 'callgrid');
  assert.ok(!/--provider|--stream/.test(RUNNER_SOURCE), 'provider is a constant, not an input');
});

test('5b. the range opens at the start of `from` and closes at the END of `to`', async () => {
  const h = harness([]);
  await runCoverage(request('2026-08-01', '2026-08-19'), h.deps);
  const asked = h.asked[0]!;
  assert.equal(asked.since.getTime(), easternBusinessDayWindow('2026-08-01').start.getTime());
  assert.equal(asked.until.getTime(), easternBusinessDayWindow('2026-08-19').end.getTime());
  // Stated in the output too, so an operator never has to guess.
  const start = find(h.lines, 'COVERAGE_START')[0] ?? '';
  assert.ok(start.includes('toIsInclusive=true'));
  assert.ok(start.includes('untilUtcExclusive='));
});

// --- 6, 7, 8, 9: the three views --------------------------------------------------

test('6. receivedAt day bucketing is deterministic and totals reconcile', async () => {
  const rows = [
    row({ receivedOn: '2026-08-10' }),
    row({ receivedOn: '2026-08-10' }),
    row({ receivedOn: '2026-08-14' }),
  ];
  const h = harness(rows);
  const result = await runCoverage(request('2026-08-01', '2026-08-19'), h.deps);
  assert.deepEqual(
    result.byReceivedDate.map((b) => [b.receivedDate, b.counts.total]),
    [
      ['2026-08-10', 2],
      ['2026-08-14', 1],
    ],
  );
  assert.equal(
    result.byReceivedDate.reduce((n, b) => n + b.counts.total, 0),
    result.totalRows,
    'the day buckets partition every scanned row',
  );
});

test('7. the occurrence day comes from the canonical resolver, never from receivedAt', async () => {
  const h = harness([row({ occurredOn: '2026-08-11', receivedOn: '2026-08-20' })]);
  const result = await runCoverage(request('2026-08-01', '2026-08-31'), h.deps);
  assert.deepEqual(result.byOccurrenceDate, [{ occurrenceDate: '2026-08-11', total: 1 }]);
  assert.deepEqual(result.byReceivedDate.map((b) => b.receivedDate), ['2026-08-20']);
  // Wired to the real thing in production, not a local copy.
  assert.ok(RUNNER_SOURCE.includes('resolveCallOccurrence'));
  assert.ok(!/UTCUnixTimeMs|UTCISODate|occurredAtUnix/.test(RUNNER_CODE), 'no second resolver here');
});

test('8. THE FIXTURE THAT MATTERS: a late delivery appears in all three views at once', async () => {
  // A call that occurred during the outage and was delivered nine days later. If
  // production looks like this, the calls arrived late and reconciliation could
  // never have counted them — it selects by delivery time within two days.
  const rows = [
    row({ occurredOn: '2026-08-11', receivedOn: '2026-08-20' }),
    row({ occurredOn: '2026-08-11', receivedOn: '2026-08-20' }),
    row({ occurredOn: '2026-08-12', receivedOn: '2026-08-20' }),
    row({ occurredOn: '2026-08-14', receivedOn: '2026-08-14' }),
  ];
  const h = harness(rows);
  const result = await runCoverage(request('2026-08-01', '2026-08-31'), h.deps);

  // 1. the LATER received bucket
  assert.deepEqual(
    result.byReceivedDate.map((b) => [b.receivedDate, b.counts.total]),
    [
      ['2026-08-14', 1],
      ['2026-08-20', 3],
    ],
  );
  // 2. the ORIGINAL occurrence bucket
  assert.deepEqual(result.byOccurrenceDate, [
    { occurrenceDate: '2026-08-11', total: 2 },
    { occurrenceDate: '2026-08-12', total: 1 },
    { occurrenceDate: '2026-08-14', total: 1 },
  ]);
  // 3. the cross-timing bucket that names both at once
  assert.deepEqual(result.crossTiming, [
    { occurrenceDate: '2026-08-11', receivedDate: '2026-08-20', count: 2 },
    { occurrenceDate: '2026-08-12', receivedDate: '2026-08-20', count: 1 },
    { occurrenceDate: '2026-08-14', receivedDate: '2026-08-14', count: 1 },
  ]);
  assert.ok(
    h.lines.some((l) =>
      l.includes('event=CROSS_TIMING') &&
      l.includes('occurrenceDate=2026-08-11') &&
      l.includes('receivedDate=2026-08-20'),
    ),
    'the shape must be visible in the printed output, not only in the result object',
  );
});

test('8b. the OTHER shape: nothing occurred on those dates at all', async () => {
  const h = harness([
    row({ receivedOn: '2026-08-10' }),
    row({ receivedOn: '2026-08-14' }),
  ]);
  const result = await runCoverage(request('2026-08-01', '2026-08-31'), h.deps);
  for (const d of ['2026-08-11', '2026-08-12', '2026-08-13']) {
    assert.ok(
      !result.byOccurrenceDate.some((b) => b.occurrenceDate === d),
      `${d} must be absent, which is the finding`,
    );
  }
  assert.equal(result.totalRows, 2);
});

test('9. statuses bucket correctly, and an unrecognised one is counted rather than dropped', async () => {
  const rows = [
    row({ receivedOn: '2026-08-11', status: 'RECEIVED' }),
    row({ receivedOn: '2026-08-11', status: 'PROCESSING' }),
    row({ receivedOn: '2026-08-11', status: 'PROCESSED' }),
    row({ receivedOn: '2026-08-11', status: 'FAILED' }),
    row({ receivedOn: '2026-08-11', status: 'IGNORED' }),
    row({ receivedOn: '2026-08-11', status: 'QUARANTINED' }),
  ];
  const h = harness(rows);
  const result = await runCoverage(request('2026-08-11', '2026-08-11'), h.deps);
  const b = result.byReceivedDate[0]!.counts;
  assert.deepEqual(
    { ...b },
    { total: 6, RECEIVED: 1, PROCESSING: 1, PROCESSED: 1, FAILED: 1, IGNORED: 1, OTHER: 1 },
  );
  assert.equal(
    b.RECEIVED + b.PROCESSING + b.PROCESSED + b.FAILED + b.IGNORED + b.OTHER,
    b.total,
    'the status split must sum to the day total',
  );
});

// --- 10, 11: quality counters -----------------------------------------------------

test('10. an unresolvable occurrence is counted, never guessed at', async () => {
  const rows = [
    row({ occurredOn: null, receivedOn: '2026-08-11' }),
    row({ occurredOn: '2026-08-11', receivedOn: '2026-08-11' }),
  ];
  const h = harness(rows);
  const result = await runCoverage(request('2026-08-11', '2026-08-11'), h.deps);
  assert.equal(result.unresolvedOccurrenceRows, 1);
  assert.equal(result.resolvedOccurrenceRows, 1);
  assert.equal(result.totalRows, 2);
  assert.equal(
    result.byOccurrenceDate.reduce((n, b) => n + b.total, 0),
    result.resolvedOccurrenceRows,
    'only resolvable rows are dated, and all of them are',
  );
});

test('11. missing identity is counted over EVERY scanned row, and no identity value is printed', async () => {
  // Deliberately different from reconciliation, where the counter is evaluated
  // AFTER the in-window filter and therefore reads zero on a day with no
  // in-window rows — which is exactly how it read on 08-11 to 08-13. Here a zero
  // is a fact.
  const rows = [
    row({ externalId: null, occurredOn: null, receivedOn: '2026-08-11' }),
    row({ externalId: '   ', receivedOn: '2026-08-11' }),
    row({ receivedOn: '2026-08-11' }),
  ];
  const h = harness(rows);
  const result = await runCoverage(request('2026-08-11', '2026-08-11'), h.deps);
  assert.equal(result.missingIdentityRows, 2, 'counted regardless of occurrence or window');
  const quality = find(h.lines, 'QUALITY')[0] ?? '';
  assert.ok(quality.includes('missingIdentity=2'));
  assert.ok(quality.includes('missingIdentityScope=every scanned row'));
});

// --- 12, 13, 14: nothing identifying can be printed --------------------------------

test('12/13/14. no payload value, external id or PII reaches the output', async () => {
  const h = harness([
    row({ occurredOn: '2026-08-11', receivedOn: '2026-08-20' }),
    row({ receivedOn: '2026-08-14' }),
  ]);
  await runCoverage(request('2026-08-01', '2026-08-31'), h.deps);
  const output = h.lines.join('\n');
  for (const secret of ['+15551234567', 'A Person', 'Roofing - TX', 'someone@example.test', 'call-', 'evt_']) {
    assert.ok(!output.includes(secret), `the output must not contain ${secret}`);
  }
  // Structural, not just this fixture: nothing in the file names a payload field
  // or prints a row value.
  for (const symbol of ['callerId', 'callerName', 'campaignName', 'campaignLabel', 'phone', 'email', 'transcript', 'recordingUrl']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not name ${symbol}`);
  }
  assert.ok(!/externalId:\s*row\.externalId/.test(RUNNER_CODE), 'an external id is tested, never carried');
  assert.ok(!/log\([^)]*payload/.test(RUNNER_CODE), 'a payload is never logged');
});

// --- 15, 16: the safety boundary ---------------------------------------------------

test('15. no provider credential is required, or named', () => {
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
  for (const secret of ['CALLGRID_API_KEY', 'CALLGRID_WEBHOOK_SECRET', 'apiKey', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY']) {
    assert.ok(!RUNNER_CODE.includes(secret), `the runner must not name ${secret}`);
  }
  assert.ok(!WORKFLOW_STEPS.includes('CALLGRID_API_KEY'), 'the workflow must not request a provider secret');
});

test('16. the runner has no mutation method and reaches no other machinery', () => {
  for (const symbol of [
    'create(',
    'update(',
    'upsert(',
    'delete(',
    'recordEvent',
    'updateEventStatus',
    'ingest(',
    'IngestionService',
    'NormalizationEngine',
    'recover',
    'backfill',
    'replay',
    'reconcileDay',
    'ProviderReconciliationService',
    'certifyDay',
    'ProviderObservationService',
    'declare',
    'registerSource',
    'declareAuthority',
    'correctMeasureDefinition',
    'assessReadiness',
    'measureChange',
    'Headline',
    'SourceOutcomeDay',
    'MarketplaceCall',
    'getCallGridProvider',
    'fetchAllCallGridCalls',
    'CallGridReconciliationService',
    'fetch(',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not name ${symbol}`);
  }
  assert.ok(!/\bsync\b/.test(RUNNER_CODE), 'the runner must not sync');
  assert.ok(!/prisma\.\w+\./.test(RUNNER_CODE), 'persistence goes through the repository');
  assert.ok(!RUNNER_CODE.includes('$executeRaw'));
  assert.ok(!RUNNER_CODE.includes('$queryRaw'));
  assert.ok(!/\bSELECT\s|\bINSERT\s|\bUPDATE\s+\w+\s+SET\b/.test(RUNNER_CODE));
  // The ONE thing borrowed from the provider package is the pure resolver.
  const providerImports = RUNNER_CODE.match(/@emgloop\/providers'\)?;?/g) ?? [];
  assert.equal(providerImports.length, 1, 'exactly one providers import, and it is the resolver');
  assert.ok(RUNNER_CODE.includes('resolveCallOccurrence'));
});

// --- 19: determinism ----------------------------------------------------------------

test('19. two reads over the same rows produce byte-identical output', async () => {
  const build = () => [
    row({ occurredOn: '2026-08-12', receivedOn: '2026-08-20' }),
    row({ occurredOn: '2026-08-11', receivedOn: '2026-08-20' }),
    row({ occurredOn: '2026-08-11', receivedOn: '2026-08-11' }),
    row({ receivedOn: '2026-08-14' }),
  ];
  const first = harness(build());
  const second = harness(build().slice().reverse());
  await runCoverage(request('2026-08-01', '2026-08-31'), first.deps);
  await runCoverage(request('2026-08-01', '2026-08-31'), second.deps);
  const strip = (l: string[]) => l.filter((x) => !x.includes('event=COVERAGE_START'));
  assert.deepEqual(
    strip(first.lines),
    strip(second.lines),
    'sorted on the way out, so database order cannot change the report',
  );
});

test('19b. batching does not change the aggregate', async () => {
  const rows = Array.from({ length: BATCH_SIZE + 7 }, () =>
    row({ occurredOn: '2026-08-11', receivedOn: '2026-08-20' }),
  );
  const h = harness(rows);
  const result = await runCoverage(request('2026-08-01', '2026-08-31'), h.deps);
  assert.equal(result.totalRows, BATCH_SIZE + 7);
  assert.deepEqual(result.crossTiming, [
    { occurrenceDate: '2026-08-11', receivedDate: '2026-08-20', count: BATCH_SIZE + 7 },
  ]);
  assert.ok(h.asked.length > 1, 'the cursor was actually used');
});

// --- 17, 18: the workflow -----------------------------------------------------------

test('17. the workflow is human-started only', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `the workflow must not carry ${trigger.trim()}`);
  }
});

test('18. the safety suite runs BEFORE the database credential is used', () => {
  const proof = WORKFLOW_SOURCE.indexOf('test:operations');
  const read = WORKFLOW_SOURCE.indexOf('read:event-coverage');
  assert.ok(proof > 0 && proof < read, 'the safety suite must run before the read step');
});

test('18b. the workflow invokes this runner and no other, and interpolates no input', () => {
  assert.ok(WORKFLOW_SOURCE.includes('read:event-coverage'));
  for (const other of [
    'read:reconciliation-evidence',
    'reconcile:provider-days',
    'certify:observation-days',
    'declare:member-expectations',
    'bootstrap:stage3',
    'migrate deploy',
  ]) {
    assert.ok(!WORKFLOW_SOURCE.includes(other), `the workflow must not invoke ${other}`);
  }
  const runBodies = WORKFLOW_SOURCE.split(/\n\s+run: \|/).slice(1);
  for (const body of runBodies) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.ok(!/\$\{\{\s*inputs\./.test(step), 'no input may be interpolated into a run body');
  }
  assert.ok(!/echo\s+"?\$\{?\{?\s*secrets\./.test(WORKFLOW_SOURCE));
});

test('the workflow states that both bounds are inclusive', () => {
  assert.ok(/from_date:[\s\S]{0,200}INCLUSIVE/.test(WORKFLOW_SOURCE));
  assert.ok(/to_date:[\s\S]{0,200}INCLUSIVE/.test(WORKFLOW_SOURCE));
});

test('no organization, campaign, date or person is hard-coded in the runner or the inputs', () => {
  for (const literal of [
    'servicesinmycity',
    '2026-08-01',
    '2026-08-11',
    'cmng68vp2001d06inikyf6zqh',
    'cmo93ju7606k306k1of3tttac',
    '@elitemediagroup',
  ]) {
    assert.ok(!RUNNER_CODE.includes(literal), `the runner must not hard-code ${literal}`);
  }
  const workflowInputs = WORKFLOW_SOURCE.split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  for (const literal of ['servicesinmycity', 'cmng68vp2001d06inikyf6zqh']) {
    assert.ok(!workflowInputs.includes(literal), `the workflow must not hard-code ${literal}`);
  }
});

test('flags parse in either spelling', () => {
  assert.deepEqual(parseArgs(['--organization', 'a', '--from', '2026-08-01', '--to', '2026-08-19']), {
    organization: 'a',
    from: '2026-08-01',
    to: '2026-08-19',
  });
  assert.deepEqual(parseArgs(['--org', 'a', '--from-date', '2026-08-01', '--to-date', '2026-08-19']), {
    organization: 'a',
    from: '2026-08-01',
    to: '2026-08-19',
  });
});
