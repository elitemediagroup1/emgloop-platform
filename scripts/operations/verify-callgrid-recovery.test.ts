// Tests for the three-population CallGrid verification reader.
//
// WHAT THESE PROVE
//
// The reason this operation exists is that "missing: 107" is not one fact. A
// provider call Loop never captured and a captured call the read model never got
// are different incidents with different responses, and a single number hides
// whichever is smaller. So the assertions that carry weight are the ones that pull
// those apart and refuse to let either collapse into the other.
//
// The second is that it never manufactures equality. A provider read that did not
// COMPLETE makes the day INCONCLUSIVE — not "agreed, we found the same number" —
// because every difference derived from a lower bound is itself a lower bound.
//
// And the third is that it cannot repair what it is auditing: there is no seam
// here through which a row could be written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { easternBusinessDayWindow, type BusinessDate } from '@emgloop/shared';

import {
  DAY_VERDICTS,
  LEGACY_SCAN_MARGIN_MS,
  OBSERVATION_SOURCE_VOCABULARY,
  REFUSED_ORGANIZATION_STATUSES,
  parseArgs,
  parseDates,
  readEnvironment,
  runVerification,
  type CapturedEvent,
  type ProviderDayRead,
  type VerifyDeps,
} from './verify-callgrid-recovery';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = readFileSync(join(HERE, 'verify-callgrid-recovery.ts'), 'utf8');
const RUNNER_CODE = RUNNER_SOURCE.split('\n')
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };
const KEY = 'cg_live_fixture';
const DATE: BusinessDate = '2026-08-11';
const WINDOW = easternBusinessDayWindow(DATE);
const IN_DAY = new Date(WINDOW.start.getTime() + 12 * 60 * 60 * 1000);

const id = (n: number) => `cmsns65v8be2d07k368ox69s${n}`;

function providerRead(over: Partial<ProviderDayRead> = {}): ProviderDayRead {
  const records = over.records ?? [{ identity: id(1) }, { identity: id(2) }];
  return {
    outcome: 'COMPLETE',
    records,
    recordsFetched: records.length,
    refused: [],
    pages: 1,
    providerTotal: null,
    ...over,
  };
}

function captured(over: Partial<CapturedEvent> & { externalId: string | null }): CapturedEvent {
  return {
    status: 'PROCESSED',
    occurredAt: IN_DAY,
    firstIngestionSource: 'WEBHOOK',
    observedSources: ['WEBHOOK'],
    ...over,
  };
}

interface Harness {
  deps: VerifyDeps;
  lines: string[];
  writes: string[];
}

function harness(options: {
  provider?: ProviderDayRead | (() => never);
  captured?: CapturedEvent[];
  projected?: string[];
  reconciliation?: { state: string | null; reconciledAt: string } | null;
  coverage?: { completedThrough: string } | null;
  conflicts?: { identities: string[]; capped: boolean };
  org?: { id: string; slug: string; name: string; status: string } | null;
  capturedInput?: (input: Record<string, unknown>) => void;
} = {}): Harness {
  const lines: string[] = [];
  const writes: string[] = [];
  let tick = 0;
  const deps: VerifyDeps = {
    provider: {
      async read() {
        const p = options.provider;
        if (typeof p === 'function') return p();
        return p ?? providerRead();
      },
    },
    captured: {
      async read(input) {
        options.capturedInput?.(input as unknown as Record<string, unknown>);
        return options.captured ?? [captured({ externalId: id(1) }), captured({ externalId: id(2) })];
      },
    },
    projected: {
      async read() {
        return options.projected ?? [id(1), id(2)];
      },
    },
    stored: {
      async reconciliationState() {
        return options.reconciliation === undefined
          ? { state: 'RECONCILED', reconciledAt: '2026-08-20T00:00:00.000Z' }
          : options.reconciliation;
      },
      async coverage() {
        return options.coverage === undefined
          ? { completedThrough: '2026-08-21T00:00:00.000Z' }
          : options.coverage;
      },
      async unresolvedConflicts() {
        return options.conflicts ?? { identities: [], capped: false };
      },
    },
    organizations: {
      async findBySlug(slug: string) {
        if (options.org === null) return null;
        const org = options.org ?? ORG;
        return org.slug === slug ? org : null;
      },
    },
    log: (l) => lines.push(l),
    now: () => new Date(1_700_000_000_000 + (tick += 1000)),
  };
  return { deps, lines, writes };
}

const run = (h: Harness, dates: readonly BusinessDate[] = [DATE]) =>
  runVerification({ organizationSlug: ORG.slug, dates, apiKey: KEY }, h.deps);

const dayLine = (lines: string[]): string => lines.find((l) => l.startsWith('event=DAY_REPORT'))!;

// --- The distinction the operation exists for ---------------------------------------

test('A PROVIDER CALL LOOP NEVER CAPTURED IS NOT THE SAME FACT AS ONE IT NEVER PROJECTED', async () => {
  const h = harness({
    // CallGrid holds three. Loop captured two of them. One of those two was never
    // projected. A single "missing" number would say 1, or 2, and be wrong either way.
    provider: providerRead({ records: [{ identity: id(1) }, { identity: id(2) }, { identity: id(3) }] }),
    captured: [captured({ externalId: id(1) }), captured({ externalId: id(2) })],
    projected: [id(1)],
  });
  const out = await run(h);
  const day = out.days[0]!;
  assert.equal(day.verdict, 'DIFFERS');
  assert.equal(day.providerOnly, 1, 'a delivery gap');
  assert.equal(day.capturedNotProjected, 1, 'a read-model gap');
  assert.equal(day.intersection, 2);
  const printed = dayLine(h.lines);
  assert.ok(printed.includes('PROVIDER_ONLY=1'));
  assert.ok(printed.includes('CAPTURED_NOT_PROJECTED=1'));
});

test('a projection with no delivery behind it is surfaced rather than ignored', async () => {
  // Should be impossible. If it happens, a report that only counted the other
  // direction would never show it.
  const h = harness({
    provider: providerRead({ records: [{ identity: id(1) }] }),
    captured: [captured({ externalId: id(1) })],
    projected: [id(1), id(9)],
  });
  const out = await run(h);
  assert.equal(out.days[0]!.projectedNotCaptured, 1);
  assert.equal(out.days[0]!.verdict, 'DIFFERS');
});

test('a day where all three agree is AGREED, and that is the only way to get it', async () => {
  const out = await run(harness());
  assert.equal(out.days[0]!.verdict, 'AGREED');
  assert.equal(out.overall, 'COMPLETE');
});

// --- Never manufacture equality ------------------------------------------------------

test('an incomplete provider read is INCONCLUSIVE, never AGREED', async () => {
  for (const outcome of ['TRUNCATED', 'RATE_LIMIT_EXHAUSTED', 'INVALID_PAGINATION', 'PROVIDER_ERROR', 'REFUSED']) {
    const h = harness({ provider: providerRead({ outcome }) });
    const out = await run(h);
    const day = out.days[0]!;
    assert.equal(day.verdict, 'INCONCLUSIVE', `${outcome} must not conclude`);
    assert.equal(day.providerLowerBound, true);
    assert.match(String(day.reason), /LOWER BOUND/);
    assert.equal(out.overall, 'INCOMPLETE', 'and the run says so overall');
  }
});

test('an incomplete read whose counts happen to match is STILL inconclusive', async () => {
  // The trap: a truncated read that returns exactly what Loop holds looks like
  // agreement and is not one.
  const h = harness({ provider: providerRead({ outcome: 'TRUNCATED' }) });
  const out = await run(h);
  assert.equal(out.days[0]!.providerOnly, 0, 'the counts match');
  assert.equal(out.days[0]!.verdict, 'INCONCLUSIVE', 'and it still concludes nothing');
});

test('a provider record the mapper refused prevents AGREED', async () => {
  const h = harness({
    provider: providerRead({ refused: [{ page: 2, reason: 'no usable identity field', kind: 'no-identity' }] }),
  });
  const out = await run(h);
  assert.equal(out.days[0]!.verdict, 'DIFFERS');
  assert.equal(out.days[0]!.providerRefused, 1);
  assert.ok(h.lines.some((l) => l.startsWith('event=PROVIDER_RECORD_REFUSED') && l.includes('page=2')));
});

test('the evidence limit is stated on EVERY run, not only when it matters', async () => {
  const out = await run(harness());
  assert.equal(out.days[0]!.verdict, 'AGREED');
  const limit = h_evidence(await Promise.resolve(harness()));
  assert.ok(limit === undefined || true);
  // A clean report must not read as more than it is: whether CallGrid ATTEMPTED
  // delivery is on the per-call detail endpoint and is not read here.
  const h = harness();
  await run(h);
  const line = h.lines.find((l) => l.startsWith('event=EVIDENCE_LIMIT'))!;
  assert.ok(line.includes('webhookDeliveryAttested=NO'));
  assert.ok(line.includes('detail endpoint'));
});
function h_evidence(_h: Harness): undefined {
  return undefined;
}

// --- Provenance and the recovery question ---------------------------------------------

test('the observation-source distribution is reported, so a recovery is visible as one', async () => {
  const h = harness({
    provider: providerRead({ records: [{ identity: id(1) }, { identity: id(2) }, { identity: id(3) }] }),
    captured: [
      captured({ externalId: id(1), firstIngestionSource: 'WEBHOOK', observedSources: ['WEBHOOK', 'API_POLL'] }),
      captured({ externalId: id(2), firstIngestionSource: 'API_RECOVERY', observedSources: ['API_RECOVERY'] }),
      captured({ externalId: id(3), firstIngestionSource: 'API_RECOVERY', observedSources: ['API_RECOVERY'] }),
    ],
    projected: [id(1), id(2), id(3)],
  });
  const out = await run(h);
  const day = out.days[0]!;
  assert.equal(day.capturedByFirstSource['API_RECOVERY'], 2, 'two rows exist because somebody recovered them');
  assert.equal(day.capturedByFirstSource['WEBHOOK'], 1);
  assert.equal(day.capturedObservedBySource['API_POLL'], 1);
  assert.equal(day.verdict, 'AGREED');
  assert.ok(dayLine(h.lines).includes('capturedByFirstSource=WEBHOOK:1|API_RECOVERY:2'));
});

test('a row with no recorded provenance is named UNRECORDED rather than guessed', async () => {
  const h = harness({
    captured: [
      captured({ externalId: id(1), firstIngestionSource: null, observedSources: [] }),
      captured({ externalId: id(2) }),
    ],
  });
  const out = await run(h);
  assert.equal(out.days[0]!.capturedByFirstSource['UNRECORDED'], 1);
  assert.equal(out.days[0]!.capturedObservedBySource['UNRECORDED'], 1);
});

test('the status distribution separates captured-and-processed from captured-and-failed', async () => {
  const h = harness({
    provider: providerRead({ records: [{ identity: id(1) }, { identity: id(2) }] }),
    captured: [
      captured({ externalId: id(1), status: 'PROCESSED' }),
      captured({ externalId: id(2), status: 'FAILED' }),
    ],
    projected: [id(1)],
  });
  const out = await run(h);
  const day = out.days[0]!;
  assert.equal(day.capturedByStatus['FAILED'], 1);
  assert.equal(day.capturedNotProjected, 1, 'the FAILED row was captured and never projected');
  assert.equal(day.providerOnly, 0, 'and it is NOT a delivery gap');
});

// --- Legacy rows -------------------------------------------------------------------------

test('a legacy row with no occurrence is counted, kept, and named as legacy', async () => {
  const h = harness({
    provider: providerRead({ records: [{ identity: id(1) }, { identity: id(2) }] }),
    captured: [captured({ externalId: id(1) }), captured({ externalId: id(2), occurredAt: null })],
    projected: [id(1), id(2)],
  });
  const out = await run(h);
  assert.equal(out.days[0]!.capturedLegacyOccurrence, 1);
  assert.equal(out.days[0]!.capturedIdentities, 2, 'it is not dropped from the comparison');
});

test('a legacy row that arrived through the delivery fallback but occurred elsewhere is excluded', async () => {
  const h = harness({
    provider: providerRead({ records: [{ identity: id(1) }] }),
    captured: [
      captured({ externalId: id(1) }),
      // Reached by the widened delivery window, occurred on another day.
      captured({ externalId: id(7), occurredAt: new Date(WINDOW.end.getTime() + 3600_000) }),
    ],
    projected: [id(1)],
  });
  const out = await run(h);
  assert.equal(out.days[0]!.capturedIdentities, 1, 'the neighbour is judged out');
  assert.equal(out.days[0]!.verdict, 'AGREED');
});

test('the legacy scan margin matches reconciliation, so both reach the same rows', async () => {
  let seen: Record<string, unknown> | null = null;
  const h = harness({ capturedInput: (input) => (seen = input) });
  await run(h);
  const captured = seen as unknown as { since: Date; until: Date; legacySince: Date; legacyUntil: Date };
  assert.equal(captured.since.getTime(), WINDOW.start.getTime(), 'the day itself, by occurrence');
  assert.equal(captured.until.getTime(), WINDOW.end.getTime());
  assert.equal(captured.legacySince.getTime(), WINDOW.start.getTime() - LEGACY_SCAN_MARGIN_MS);
  assert.equal(captured.legacyUntil.getTime(), WINDOW.end.getTime() + LEGACY_SCAN_MARGIN_MS);
  assert.equal(LEGACY_SCAN_MARGIN_MS, 2 * 24 * 60 * 60 * 1000);
});

// --- Stored evidence ------------------------------------------------------------------------

test('the stored reconciliation verdict and coverage boundary are read, not recomputed', async () => {
  const h = harness({
    reconciliation: { state: 'MISSING_INGESTION', reconciledAt: '2026-08-20T10:00:00.000Z' },
    coverage: { completedThrough: '2026-08-21T09:00:00.000Z' },
  });
  const out = await run(h);
  assert.equal(out.days[0]!.reconciliationState, 'MISSING_INGESTION');
  assert.equal(out.coverageProvenThrough, '2026-08-21T09:00:00.000Z');
  // Read as evidence beside the live comparison, so a stale verdict is VISIBLE
  // next to what is true now rather than being quietly replaced by it.
  assert.ok(dayLine(h.lines).includes('reconciliationState=MISSING_INGESTION'));
});

test('a day with no stored verdict reports null rather than inventing one', async () => {
  const h = harness({ reconciliation: null, coverage: null });
  const out = await run(h);
  assert.equal(out.days[0]!.reconciliationState, null);
  assert.equal(out.coverageProvenThrough, null);
});

test('unresolved fact conflicts are counted for the day, and a capped list says so', async () => {
  const h = harness({ conflicts: { identities: [id(2)], capped: true } });
  const out = await run(h);
  assert.equal(out.days[0]!.unresolvedConflicts, 1);
  assert.equal(out.days[0]!.conflictsCapped, true, 'so nobody reads 1 as "only 1"');
});

// --- Sweep behaviour ---------------------------------------------------------------------------

test('every requested date is verified: the sweep does NOT stop at the first bad day', async () => {
  // The opposite of the certification sweep, deliberately. That one WRITES, so
  // continuing past a failure fills a ledger nobody looked at. This writes
  // nothing, and an operator checking a recovery wants the whole picture.
  const h = harness({ provider: providerRead({ outcome: 'TRUNCATED' }) });
  const out = await run(h, ['2026-08-11', '2026-08-12', '2026-08-13']);
  assert.equal(out.days.length, 3);
  assert.equal(out.overall, 'INCOMPLETE');
});

test('a day whose provider read throws is FAILED and does not stop the others', async () => {
  const h = harness({
    provider: () => {
      throw new Error('socket hang up');
    },
  });
  const out = await run(h, ['2026-08-11', '2026-08-12']);
  assert.equal(out.days.length, 2);
  assert.equal(out.days[0]!.verdict, 'FAILED');
  assert.equal(out.overall, 'INCOMPLETE');
});

test('preconditions refuse before any provider request', async () => {
  assert.equal((await run(harness({ org: null }))).overall, 'FAILED_PRECONDITION');
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const h = harness({ org: { ...ORG, status } });
    assert.equal((await run(h)).overall, 'FAILED_PRECONDITION');
    assert.equal(h.lines.filter((l) => l.startsWith('event=DAY_REPORT')).length, 0);
  }
  assert.equal((await run(harness(), [])).overall, 'FAILED_PRECONDITION');
});

// --- Arguments, secrets, structure ------------------------------------------------------------

test('dates are validated with the same predicate everything else uses', () => {
  assert.deepEqual(parseDates('2026-08-11, 2026-08-12').dates, ['2026-08-11', '2026-08-12']);
  assert.deepEqual(parseDates('yesterday').invalid, ['yesterday']);
  assert.deepEqual(parseArgs(['--organization', 'x', '--dates', 'a']), { organization: 'x', dates: 'a' });
});

test('a shape-valid but impossible date is refused, so no day is reported on a date that never existed', () => {
  // This assertion is the other half of a pair. `isBusinessDate` used to be a
  // SHAPE check, so 2026-13-99 passed it here and in every other date-taking
  // operation -- including two that write ledger rows. While that was true this
  // test pinned the gap so the root fix would visibly change it rather than
  // passing silently; the root fix landed on main, and this is what it changed it
  // to. A verification reader that accepted an impossible date would have reported
  // a day derived from a month that does not exist.
  assert.deepEqual(parseDates('2026-13-99').dates, []);
  assert.deepEqual(parseDates('2026-13-99').invalid, ['2026-13-99']);
  assert.deepEqual(parseDates('2026-02-31').invalid, ['2026-02-31'], 'and one that silently coerces');
});

test('missing credentials are reported by NAME and never by value', () => {
  const out = readEnvironment({ DATABASE_URL: '', CALLGRID_API_KEY: '' } as NodeJS.ProcessEnv);
  assert.equal(out.ok, false);
  assert.deepEqual(out.ok === false ? out.missing : [], ['DATABASE_URL', 'CALLGRID_API_KEY']);
});

test('no line carries a credential, a raw identity, a payload or a phone number', async () => {
  const h = harness({
    captured: [captured({ externalId: id(1) }), captured({ externalId: id(2) })],
  });
  await run(h);
  for (const l of h.lines) {
    assert.ok(!l.includes(KEY), 'a credential leaked');
    assert.ok(!l.includes(id(1)), 'a provider identity leaked');
  }
  // It never reaches for one in the first place.
  for (const symbol of ['customerPhone', 'customerEmail', 'callerNumber', 'recordingUrl', 'transcript']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not read ${symbol}`);
  }
});

test('THE OPERATION CANNOT WRITE, AND HAS NO SEAM THROUGH WHICH IT COULD', () => {
  assert.equal(/prisma\.[a-z]/.test(RUNNER_CODE), false, 'no Prisma model delegate');
  assert.equal(
    /\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\(\s*\{/.test(RUNNER_CODE),
    false,
    'no persistence call',
  );
  for (const symbol of [
    'IngestionService',
    '.ingest(',
    'executeRecovery',
    'CallGridPollService',
    'CallGridRoutinePollService',
    'projectInteraction',
    'projectWindow',
    'recordDay',
    'reconcileDay',
    'certifyDay',
    'advance(',
    'assessReadiness',
    'HeadlineDetectionService',
    '--apply',
    '$executeRaw',
    '$queryRaw',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the read-only reader must not reference ${symbol}`);
  }
  // Only READ methods are reachable through its seams.
  assert.ok(RUNNER_CODE.includes('listEventsForOccurrenceWindow'));
  assert.ok(RUNNER_CODE.includes('listIdentitiesInWindow'));
  assert.ok(RUNNER_CODE.includes('readCallGridInterval'), 'the canonical provider reader');
});

test('it enumerates the provider through the SAME reader the poll and recovery use', () => {
  // A verification that enumerated the provider differently could disagree with
  // the thing it is verifying, and nobody would know which was wrong.
  for (const symbol of ['fetchCallGridCallsPage', 'nextCursor', 'getCallGridProvider']) {
    assert.ok(!RUNNER_CODE.includes(symbol), `pagination belongs to the reader, not ${symbol}`);
  }
});

test('the verdict vocabulary is closed and the observation vocabulary is the shipped one', () => {
  assert.deepEqual([...DAY_VERDICTS].sort(), ['AGREED', 'DIFFERS', 'FAILED', 'INCONCLUSIVE']);
  // Widened by the FAILED-event drain: a reprocess asks no provider anything, so
  // recording it as WEBHOOK or API_POLL would say CallGrid was asked when it was
  // not. The verifier buckets by whatever string a row carries, so a widened
  // vocabulary shows up as its own bucket rather than as UNRECORDED -- which is
  // what makes a re-offered row distinguishable from a re-read one in a report.
  assert.deepEqual(
    [...OBSERVATION_SOURCE_VOCABULARY],
    ['WEBHOOK', 'API_POLL', 'API_RECOVERY', 'LOCAL_REPROCESS'],
  );
});

test('importing the module does not start a verification', () => {
  assert.notEqual(process.exitCode, 2);
  assert.ok(!process.exitCode);
});
