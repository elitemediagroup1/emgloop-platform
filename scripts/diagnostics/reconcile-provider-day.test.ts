// Tests for the provider/local identity reconciliation diagnostic.
//
// Two kinds of test live here, deliberately.
//
// BEHAVIOUR — the set algebra, the refusals, and the characterisation. These
// drive the pure functions through injected seams; no database and no provider
// is constructed, which is why the module can be imported at all.
//
// CONSTRAINT — assertions about the SOURCE TEXT. A diagnostic's most important
// property is what it cannot do, and "it does not ingest" is not observable from
// its output. Reading the file and asserting the absence of every write-path
// name makes the guarantee fail at test time rather than at review time, which
// is the only kind of guarantee this repository has any evidence works.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  DELIVERY_PATH_MARKERS,
  FORBIDDEN_OUTPUT_FIELDS,
  IDENTITY_COHERENCE_FLOOR,
  RECONCILIATION_PAGE_CAP,
  SAFE_PROVIDER_FIELDS,
  boundaryAnalysisOf,
  cohortOf,
  distribution,
  durationBucket,
  hashIdentity,
  labelOf,
  markersFrom,
  normaliseIdentity,
  parseArgs,
  readEnvironment,
  reconcileSets,
  runReconciliation,
  safeFieldsFrom,
  verdictFor,
  type DayWindow,
  type LocalFact,
  type ProviderFact,
  type ProviderRead,
  type ReconcileDeps,
} from './reconcile-provider-day';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'reconcile-provider-day.ts'), 'utf8');

/**
 * The diagnostic's source with comments removed.
 *
 * The constraint tests below ban the NAMES of every write path. The file's own
 * header names several of them on purpose — "there is no IngestionService here"
 * is the most useful sentence in it — so a check run over the raw text would
 * fail on its own documentation and the fix would be to delete the sentence.
 * The ban is about what the code CALLS, so the check reads the code.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

// August 5 2026 Eastern is UTC-4, so the day is [04:00Z, next 04:00Z).
const WINDOW: DayWindow = {
  businessDate: '2026-08-05' as DayWindow['businessDate'],
  timezone: 'America/New_York',
  start: new Date('2026-08-05T04:00:00.000Z'),
  end: new Date('2026-08-06T04:00:00.000Z'),
};

function providerFact(identity: string, iso: string, fields: Record<string, string | null> = {}): ProviderFact {
  const base: Record<string, string | null> = {};
  for (const key of SAFE_PROVIDER_FIELDS) base[key] = null;
  return { identity, occurredAt: new Date(iso), fields: { ...base, ...fields } };
}

function localFact(identity: string | null, iso: string | null, status = 'PROCESSED'): LocalFact {
  const markers: Record<string, boolean> = {};
  for (const key of DELIVERY_PATH_MARKERS) markers[key] = key === 'occurredAtUnix';
  return { identity, occurredAt: iso === null ? null : new Date(iso), status, markers };
}

// --- Identity normalisation ---------------------------------------------------

test('identity normalisation trims, coerces numbers, and rejects empties', () => {
  assert.equal(normaliseIdentity('  abc  '), 'abc');
  assert.equal(normaliseIdentity(123), '123');
  assert.equal(normaliseIdentity(''), null);
  assert.equal(normaliseIdentity('   '), null);
  assert.equal(normaliseIdentity(null), null);
  assert.equal(normaliseIdentity(undefined), null);
  assert.equal(normaliseIdentity({}), null);
});

test('identity case is preserved — a cuid differing only in case is a different call', () => {
  assert.notEqual(normaliseIdentity('AbC'), normaliseIdentity('abc'));
});

test('the webhook string form and a REST numeric form of one id compare equal', () => {
  // The webhook template sends every value as a quoted string; a REST client may
  // return a native number. Without coercion the same call would appear on both
  // sides of the difference at once.
  assert.equal(normaliseIdentity('4021'), normaliseIdentity(4021));
});

// --- Set algebra --------------------------------------------------------------

test('a clean day reconciles with an empty difference in both directions', () => {
  const provider = [providerFact('a', '2026-08-05T10:00:00Z'), providerFact('b', '2026-08-05T11:00:00Z')];
  const local = [localFact('a', '2026-08-05T10:00:00Z'), localFact('b', '2026-08-05T11:00:00Z')];
  const { sets } = reconcileSets(provider, local, WINDOW);
  assert.equal(sets.intersection, 2);
  assert.equal(sets.providerOnly, 0);
  assert.equal(sets.localOnly, 0);
  assert.equal(verdictFor(sets, false), 'RECONCILED_COMPLETE');
});

test('provider-only identities are counted and both set equations hold', () => {
  const provider = [
    providerFact('a', '2026-08-05T10:00:00Z'),
    providerFact('b', '2026-08-05T11:00:00Z'),
    providerFact('c', '2026-08-05T12:00:00Z'),
  ];
  const local = [localFact('a', '2026-08-05T10:00:00Z')];
  const { sets } = reconcileSets(provider, local, WINDOW);
  assert.equal(sets.providerUnique, 3);
  assert.equal(sets.localUnique, 1);
  assert.equal(sets.intersection, 1);
  assert.equal(sets.providerOnly, 2);
  assert.equal(sets.localOnly, 0);
  assert.equal(sets.providerUnique, sets.intersection + sets.providerOnly);
  assert.equal(sets.localUnique, sets.intersection + sets.localOnly);
  assert.ok(sets.providerEquationHolds && sets.localEquationHolds);
});

test('a duplicate on either side shifts row counts but never the identity difference', () => {
  // This is the exact trap the August 5 Interaction duplicate sprang on a
  // count-based reading: 868 rows, 867 identities, and nothing missing.
  const provider = [providerFact('a', '2026-08-05T10:00:00Z'), providerFact('a', '2026-08-05T10:00:01Z')];
  const local = [
    localFact('a', '2026-08-05T10:00:00Z'),
    localFact('a', '2026-08-05T10:00:00Z'),
    localFact('a', '2026-08-05T10:00:00Z'),
  ];
  const { sets } = reconcileSets(provider, local, WINDOW);
  assert.equal(sets.providerRecords, 2);
  assert.equal(sets.providerUnique, 1);
  assert.equal(sets.providerExcessRows, 1);
  assert.equal(sets.providerDuplicateIds, 1);
  assert.equal(sets.localInWindow, 3);
  assert.equal(sets.localUnique, 1);
  assert.equal(sets.localDuplicateIds, 1);
  assert.equal(sets.providerOnly, 0);
  assert.equal(sets.localOnly, 0);
  assert.equal(verdictFor(sets, false), 'RECONCILED_COMPLETE');
});

test('local rows outside the occurrence window are excluded, whenever they were delivered', () => {
  // A webhook that arrived a day late still belongs to the day it OCCURRED on;
  // one that occurred outside the window does not count toward it.
  const provider = [providerFact('inside', '2026-08-05T10:00:00Z')];
  const local = [
    localFact('inside', '2026-08-05T10:00:00Z'),
    localFact('before', '2026-08-05T03:59:59Z'),
    localFact('after', '2026-08-06T04:00:00Z'),
  ];
  const { sets } = reconcileSets(provider, local, WINDOW);
  assert.equal(sets.localRows, 3);
  assert.equal(sets.localInWindow, 1);
  assert.equal(sets.localUnique, 1);
  assert.equal(sets.localOnly, 0);
});

test('the window is half-open — the closing instant belongs to the next day', () => {
  const local = [localFact('edge', '2026-08-06T04:00:00.000Z'), localFact('open', '2026-08-05T04:00:00.000Z')];
  const { sets } = reconcileSets([], local, WINDOW);
  assert.equal(sets.localInWindow, 1);
});

test('a local row whose occurrence cannot be resolved is counted, never silently dropped', () => {
  const { sets } = reconcileSets([], [localFact('x', null)], WINDOW);
  assert.equal(sets.localUnresolvedOccurrence, 1);
  assert.equal(sets.localInWindow, 0);
});

test('a local row inside the window with no identity is counted separately', () => {
  const { sets } = reconcileSets([], [localFact(null, '2026-08-05T10:00:00Z')], WINDOW);
  assert.equal(sets.localMissingIdentity, 1);
  assert.equal(sets.localUnique, 0);
});

test('local-only identities are reported rather than assumed to be zero', () => {
  const { sets } = reconcileSets(
    [providerFact('a', '2026-08-05T10:00:00Z')],
    [localFact('a', '2026-08-05T10:00:00Z'), localFact('ghost', '2026-08-05T11:00:00Z')],
    WINDOW,
  );
  assert.equal(sets.localOnly, 1);
  assert.equal(verdictFor(sets, false), 'LOCAL_ONLY_POPULATION');
  const both = reconcileSets(
    [providerFact('a', '2026-08-05T10:00:00Z'), providerFact('b', '2026-08-05T10:30:00Z')],
    [localFact('a', '2026-08-05T10:00:00Z'), localFact('ghost', '2026-08-05T11:00:00Z')],
    WINDOW,
  );
  assert.equal(verdictFor(both.sets, false), 'BOTH_DIRECTIONS');
});

// --- Refusals -----------------------------------------------------------------

test('a truncated provider read yields no reconciliation verdict, whatever the sets say', () => {
  const { sets } = reconcileSets(
    [providerFact('a', '2026-08-05T10:00:00Z')],
    [localFact('a', '2026-08-05T10:00:00Z')],
    WINDOW,
  );
  assert.equal(verdictFor(sets, false), 'RECONCILED_COMPLETE');
  assert.equal(verdictFor(sets, true), 'INCONCLUSIVE_PROVIDER_TRUNCATED');
});

test('a near-empty intersection is a mapping defect, not a report that everything is missing', () => {
  const provider = Array.from({ length: 100 }, (_, i) => providerFact(`p${i}`, '2026-08-05T10:00:00Z'));
  const local = Array.from({ length: 100 }, (_, i) => localFact(`l${i}`, '2026-08-05T10:00:00Z'));
  const { sets } = reconcileSets(provider, local, WINDOW);
  assert.equal(sets.intersection, 0);
  assert.equal(verdictFor(sets, false), 'INCONCLUSIVE_IDENTITY_INCOHERENT');
});

test('the coherence floor admits a genuine difference and rejects a disjoint one', () => {
  assert.equal(IDENTITY_COHERENCE_FLOOR, 0.5);
  // 867 matched of 867 local: an ordinary provider-only finding.
  const provider = Array.from({ length: 974 }, (_, i) => providerFact(`c${i}`, '2026-08-05T10:00:00Z'));
  const local = Array.from({ length: 867 }, (_, i) => localFact(`c${i}`, '2026-08-05T10:00:00Z'));
  const { sets } = reconcileSets(provider, local, WINDOW);
  assert.equal(sets.intersection, 867);
  assert.equal(sets.providerOnly, 107);
  assert.equal(verdictFor(sets, false), 'PROVIDER_ONLY_POPULATION');
});

test('a violated set equation reports a diagnostic defect and outranks any finding', () => {
  const broken = {
    providerRecords: 10, providerUnique: 10, providerDuplicateIds: 0, providerExcessRows: 0,
    localRows: 10, localInWindow: 10, localUnresolvedOccurrence: 0, localMissingIdentity: 0,
    localUnique: 10, localDuplicateIds: 0, intersection: 5, providerOnly: 2, localOnly: 5,
    providerEquationHolds: false, localEquationHolds: true,
  };
  assert.equal(verdictFor(broken, false), 'DIAGNOSTIC_DEFECT');
  // Truncation still outranks it: a lower bound cannot even be checked.
  assert.equal(verdictFor(broken, true), 'INCONCLUSIVE_PROVIDER_TRUNCATED');
});

// --- Characterisation ---------------------------------------------------------

test('absence is its own category and is never folded into a false value', () => {
  assert.equal(labelOf(null), '(absent)');
  assert.equal(labelOf(undefined), '(absent)');
  assert.equal(labelOf(''), '(absent)');
  assert.equal(labelOf(false), 'false');
  assert.equal(labelOf(0), '0');
});

test('duration bucketing keeps an unknown duration out of the zero bucket', () => {
  assert.equal(durationBucket(null), '(absent)');
  assert.equal(durationBucket(''), '(absent)');
  assert.equal(durationBucket('not-a-number'), '(absent)');
  assert.equal(durationBucket(0), '0s');
  assert.equal(durationBucket('7'), '1-10s');
  assert.equal(durationBucket(30), '11-30s');
  assert.equal(durationBucket(60), '31-60s');
  assert.equal(durationBucket(61), '60s+');
});

test('distributions sort by descending count, then label, so two runs read the same', () => {
  const d = distribution(['b', 'a', 'a', 'c', 'c']);
  assert.deepEqual(Object.keys(d), ['a', 'c', 'b']);
});

test('a cohort carries every allowlisted field so a comparison is never one-sided', () => {
  const cohort = cohortOf('provider-only', [providerFact('a', '2026-08-05T10:00:00Z', { noRoute: 'true' })]);
  assert.equal(cohort.count, 1);
  for (const key of SAFE_PROVIDER_FIELDS) {
    if (key === 'durationSeconds') continue;
    assert.ok(cohort.fields[key], `cohort is missing field ${key}`);
  }
  assert.equal(cohort.fields['noRoute']?.['true'], 1);
});

test('an empty cohort produces empty distributions rather than throwing', () => {
  const cohort = cohortOf('provider-only', []);
  assert.equal(cohort.count, 0);
  assert.deepEqual(cohort.durationBuckets, {});
});

// --- Boundary -----------------------------------------------------------------

test('boundary analysis separates a clustered difference from a spread one', () => {
  const clustered = boundaryAnalysisOf(WINDOW, [
    new Date('2026-08-05T04:05:00Z'),
    new Date('2026-08-05T04:10:00Z'),
    new Date('2026-08-06T03:50:00Z'),
  ]);
  assert.equal(clustered.firstFifteenMinutes, 2);
  assert.equal(clustered.lastFifteenMinutes, 1);
  assert.equal(clustered.firstHour, 2);
  assert.equal(clustered.lastHour, 1);

  const spread = boundaryAnalysisOf(WINDOW, [
    new Date('2026-08-05T09:00:00Z'),
    new Date('2026-08-05T15:00:00Z'),
    new Date('2026-08-05T21:00:00Z'),
  ]);
  assert.equal(spread.firstFifteenMinutes, 0);
  assert.equal(spread.lastFifteenMinutes, 0);
});

test('the hourly histogram has 24 buckets and conserves every record', () => {
  const dates = [
    new Date('2026-08-05T04:30:00Z'),
    new Date('2026-08-05T05:30:00Z'),
    new Date('2026-08-05T05:45:00Z'),
    new Date('2026-08-06T03:59:00Z'),
  ];
  const b = boundaryAnalysisOf(WINDOW, dates);
  assert.equal(b.hourly.length, 24);
  assert.equal(b.hourly.reduce((a, n) => a + n, 0), dates.length);
  assert.equal(b.hourly[0], 1);
  assert.equal(b.hourly[1], 2);
  assert.equal(b.hourly[23], 1);
  assert.equal(b.earliest, '2026-08-05T04:30:00.000Z');
  assert.equal(b.latest, '2026-08-06T03:59:00.000Z');
});

test('boundary analysis of an empty population reports nulls, not a fabricated instant', () => {
  const b = boundaryAnalysisOf(WINDOW, []);
  assert.equal(b.earliest, null);
  assert.equal(b.latest, null);
});

// --- PII ----------------------------------------------------------------------

test('the allowlist copies only named fields and drops everything else', () => {
  const fields = safeFieldsFrom({
    callStatus: 'ENDED',
    noRoute: true,
    caller: '+15125550142',
    callerId: '+15125550142',
    fromNumber: '+15125550142',
    to: '+15125550199',
    inboundZip: '78701',
    recordingUrl: 'https://example.invalid/r.mp3',
  });
  assert.equal(fields['callStatus'], 'ENDED');
  assert.equal(fields['noRoute'], 'true');
  for (const banned of FORBIDDEN_OUTPUT_FIELDS) {
    assert.equal(fields[banned], undefined, `${banned} must never survive the allowlist`);
  }
  assert.deepEqual(Object.keys(fields).sort(), [...SAFE_PROVIDER_FIELDS].sort());
});

test('inboundState is deliberately absent from the allowlist', () => {
  assert.ok(!(SAFE_PROVIDER_FIELDS as readonly string[]).includes('inboundState'));
});

test('a phone number cannot reach a cohort distribution', () => {
  const cohort = cohortOf(
    'provider-only',
    [{ identity: 'a', occurredAt: new Date('2026-08-05T10:00:00Z'), fields: safeFieldsFrom({ caller: '+15125550142' }) }],
  );
  const rendered = JSON.stringify(cohort);
  assert.ok(!rendered.includes('5125550142'), 'a caller number reached the cohort');
});

test('identity hashes are short, stable and not the identity', () => {
  const h = hashIdentity('cmrr0gv2p3g8n07jv41p11p6s');
  assert.equal(h.length, 12);
  assert.equal(h, hashIdentity('cmrr0gv2p3g8n07jv41p11p6s'));
  assert.notEqual(h, 'cmrr0gv2p3g8n07jv41p11p6s');
  assert.notEqual(hashIdentity('a'), hashIdentity('b'));
});

test('id hashes are printed only when explicitly requested, and are bounded', () => {
  assert.equal(parseArgs(['--organization', 'o', '--date', '2026-08-05']).idHashes, 0);
  assert.equal(parseArgs(['--id-hashes', '5']).idHashes, 5);
  assert.equal(parseArgs(['--id-hashes', '9999']).idHashes, 25);
  assert.equal(parseArgs(['--id-hashes', '-3']).idHashes, 0);
  assert.equal(parseArgs(['--id-hashes', 'many']).idHashes, 0);
});

// --- Delivery-path markers ----------------------------------------------------

test('delivery-path markers record key PRESENCE, including a falsey value', () => {
  const m = markersFrom({ occurredAtUnix: '1785902670', apiSource: '' });
  assert.equal(m['occurredAtUnix'], true);
  assert.equal(m['apiSource'], true, 'an empty string is still a present key');
  assert.equal(m['callSid'], false);
});

test('apiSource is a marker, because only the REST mapper stamps it', () => {
  assert.ok((DELIVERY_PATH_MARKERS as readonly string[]).includes('apiSource'));
  assert.ok((DELIVERY_PATH_MARKERS as readonly string[]).includes('occurredAtUnix'));
});

// --- Preconditions ------------------------------------------------------------

test('missing credentials are named, never guessed at or defaulted', () => {
  const none = readEnvironment({});
  assert.equal(none.ok, false);
  if (!none.ok) assert.deepEqual(none.missing.sort(), ['CALLGRID_API_KEY', 'DATABASE_URL']);
  const partial = readEnvironment({ DATABASE_URL: 'postgres://x' });
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.deepEqual(partial.missing, ['CALLGRID_API_KEY']);
  const both = readEnvironment({ DATABASE_URL: 'postgres://x', CALLGRID_API_KEY: 'k' });
  assert.equal(both.ok, true);
});

test('whitespace-only credentials fail closed rather than being sent as a key', () => {
  const r = readEnvironment({ DATABASE_URL: '   ', CALLGRID_API_KEY: '  ' });
  assert.equal(r.ok, false);
});

// --- Orchestration ------------------------------------------------------------

function deps(overrides: {
  read?: ProviderRead;
  localFacts?: LocalFact[];
  organizations?: ReconcileDeps['organizations'];
}): {
  deps: ReconcileDeps;
  lines: string[];
  providerCalls: number;
} {
  const lines: string[] = [];
  let providerCalls = 0;
  const read: ProviderRead = overrides.read ?? {
    facts: [providerFact('a', '2026-08-05T10:00:00Z')],
    recordsFetched: 1,
    pagesFetched: 1,
    pageCap: RECONCILIATION_PAGE_CAP,
    truncated: false,
  };
  const state = {
    deps: {
      provider: {
        async enumerate() {
          providerCalls += 1;
          return read;
        },
      },
      local: {
        async read() {
          return overrides.localFacts ?? [localFact('a', '2026-08-05T10:00:00Z')];
        },
      },
      organizations: {
        async findBySlug(slug: string) {
          return { id: 'org_1', slug, name: 'Test', status: 'ACTIVE' };
        },
      },
      log: (l: string) => lines.push(l),
      now: () => new Date('2026-08-18T12:00:00Z'),
      ...(overrides.organizations ? { organizations: overrides.organizations } : {}),
    } as ReconcileDeps,
    lines,
    get providerCalls() {
      return providerCalls;
    },
  };
  return state;
}

test('an unknown organization fails closed before the provider is ever called', async () => {
  const d = deps({
    organizations: {
      async findBySlug() {
        return null;
      },
    },
  });
  const result = await runReconciliation(
    { organizationSlug: 'nope', businessDate: '2026-08-05' as never, apiKey: 'k', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  assert.equal(result.verdict, 'FAILED_PRECONDITION');
  assert.equal(d.providerCalls, 0, 'the provider was contacted for an organization that does not exist');
});

test('a suspended organization is refused', async () => {
  const d = deps({
    organizations: {
      async findBySlug(slug: string) {
        return { id: 'o', slug, name: 'n', status: 'SUSPENDED' };
      },
    },
  });
  const result = await runReconciliation(
    { organizationSlug: 'x', businessDate: '2026-08-05' as never, apiKey: 'k', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  assert.equal(result.verdict, 'FAILED_PRECONDITION');
  assert.match(String(result.error), /SUSPENDED/);
});

test('a non-business date is refused before anything connects', async () => {
  const d = deps({});
  const result = await runReconciliation(
    { organizationSlug: 'x', businessDate: '05/08/2026' as never, apiKey: 'k', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  assert.equal(result.verdict, 'FAILED_PRECONDITION');
  assert.equal(d.providerCalls, 0);
});

test('a truncated read returns inconclusive and computes no sets at all', async () => {
  const d = deps({
    read: {
      facts: [providerFact('a', '2026-08-05T10:00:00Z')],
      recordsFetched: 10_000,
      pagesFetched: 100,
      pageCap: 100,
      truncated: true,
    },
  });
  const result = await runReconciliation(
    { organizationSlug: 'x', businessDate: '2026-08-05' as never, apiKey: 'k', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  assert.equal(result.verdict, 'INCONCLUSIVE_PROVIDER_TRUNCATED');
  assert.equal(result.sets, null, 'a lower bound must not produce a set difference');
  assert.equal(result.providerOnlyCohort, null);
});

test('the run uses the Eastern day window, not a UTC midnight', async () => {
  const d = deps({});
  const result = await runReconciliation(
    { organizationSlug: 'x', businessDate: '2026-08-05' as never, apiKey: 'k', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  assert.equal(result.window?.start.toISOString(), '2026-08-05T04:00:00.000Z');
  assert.equal(result.window?.end.toISOString(), '2026-08-06T04:00:00.000Z');
  assert.equal(result.window?.timezone, 'America/New_York');
});

test('a provider-only finding is reported with both cohorts and is not an error', async () => {
  const d = deps({
    read: {
      facts: [
        providerFact('a', '2026-08-05T10:00:00Z', { noRoute: 'false' }),
        providerFact('b', '2026-08-05T11:00:00Z', { noRoute: 'true' }),
      ],
      recordsFetched: 2,
      pagesFetched: 1,
      pageCap: 100,
      truncated: false,
    },
    localFacts: [localFact('a', '2026-08-05T10:00:00Z')],
  });
  const result = await runReconciliation(
    { organizationSlug: 'x', businessDate: '2026-08-05' as never, apiKey: 'k', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  assert.equal(result.verdict, 'PROVIDER_ONLY_POPULATION');
  assert.equal(result.sets?.providerOnly, 1);
  assert.equal(result.providerOnlyCohort?.count, 1);
  assert.equal(result.matchedCohort?.count, 1, 'the matched cohort is required to judge prevalence');
  assert.equal(result.deliveryPath?.['occurredAtUnix'], 1);
  assert.equal(result.deliveryPath?.['apiSource'], 0);
});

test('no identity is ever printed, and hashes appear only on request', async () => {
  const d = deps({
    read: {
      facts: [providerFact('secret-call-id', '2026-08-05T10:00:00Z')],
      recordsFetched: 1,
      pagesFetched: 1,
      pageCap: 100,
      truncated: false,
    },
    localFacts: [localFact('other', '2026-08-05T10:00:00Z')],
  });
  const result = await runReconciliation(
    { organizationSlug: 'x', businessDate: '2026-08-05' as never, apiKey: 'k', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  // Disjoint sets here, so the verdict is the incoherence refusal — the point of
  // this test is the OUTPUT, which must not carry the id either way.
  assert.ok(!d.lines.join('\n').includes('secret-call-id'));
  assert.deepEqual(result.idHashes, []);
});

test('the api key is never written to the log', async () => {
  const d = deps({});
  await runReconciliation(
    { organizationSlug: 'x', businessDate: '2026-08-05' as never, apiKey: 'super-secret-key', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  assert.ok(!d.lines.join('\n').includes('super-secret-key'));
});

test('the run declares that it writes nothing', async () => {
  const d = deps({});
  await runReconciliation(
    { organizationSlug: 'x', businessDate: '2026-08-05' as never, apiKey: 'k', providerName: 'callgrid', idHashes: 0 },
    d.deps,
  );
  assert.ok(d.lines.some((l) => l.includes('writes=none')));
});

// --- Constraint tests over the source text ------------------------------------

test('the diagnostic references no write path anywhere in its source', () => {
  // Each of these is a way to change production. None may appear. This is the
  // property that makes "read-only" checkable rather than promised.
  const FORBIDDEN = [
    'IngestionService',
    'NormalizationEngine',
    'MarketplaceCallRepository',
    'projectInteraction',
    'projectWindow',
    'CallGridReconciliationService',
    'ProviderObservationService',
    'ProviderObservationRepository',
    'certifyDay',
    'recordDay',
    'updateConnection',
    'createConnection',
    'recordEvent',
    'updateEventStatus',
    'ensureLiveOrganization',
    '$executeRaw',
    '$transaction',
  ];
  for (const name of FORBIDDEN) {
    assert.ok(!CODE.includes(name), `the diagnostic must not reference ${name}`);
  }
});

test('the diagnostic performs no Prisma mutation of any kind', () => {
  // Anchored to a Prisma model receiver rather than to the bare verb. A blanket
  // ban on `.update(` was the first version and it failed on `createHash(...)
  // .update(...)` — a check that flags a hash as a database write is not a
  // safety property, it is noise that gets switched off the first time it fires.
  const MUTATIONS = /prisma\.[A-Za-z]+\.(create|update|upsert|delete|createMany|updateMany|deleteMany|createManyAndReturn)\s*\(/;
  assert.ok(!MUTATIONS.test(CODE), 'the diagnostic must not call a Prisma mutation');
  // The repository seam is read-only by name too: only the windowed reader and
  // the organization lookup may appear.
  const REPO_CALLS = [...CODE.matchAll(/repositories\.[A-Za-z]+\.([A-Za-z]+)/g)].map((m) => m[1]);
  const ALLOWED_REPO_CALLS = ['listEventsForOccurrenceWindow', 'findBySlug'];
  for (const call of REPO_CALLS) {
    assert.ok(
      ALLOWED_REPO_CALLS.includes(String(call)),
      `the diagnostic may only call ${ALLOWED_REPO_CALLS.join(' / ')} on a repository, not ${String(call)}`,
    );
  }
});

test('the only .update( in the file is the identity hash', () => {
  // Every occurrence must be the crypto digest. Anything else is a write.
  const total = [...CODE.matchAll(/\.update\(/g)].length;
  const hashed = [...CODE.matchAll(/createHash\('sha256'\)\.update\(/g)].length;
  assert.equal(total, hashed, 'a .update( call that is not the identity hash appeared');
  assert.equal(hashed, 1);
});

test('the diagnostic names no PII field in its source', () => {
  // The allowlist and the ban list are themselves declarations, so the check
  // looks for a field being READ, not for the word appearing in a constant.
  for (const field of ['payload.caller', 'payload.callerId', 'payload.fromNumber', "payload['caller']"]) {
    assert.ok(!SOURCE.includes(field), `the diagnostic must not read ${field}`);
  }
});

test('the page cap matches certification rather than being a second opinion', () => {
  assert.equal(RECONCILIATION_PAGE_CAP, 100);
});

test('the entry-point guard is anchored so importing this test cannot start a run', () => {
  assert.ok(SOURCE.includes('/[\\\\/]reconcile-provider-day\\.ts$/'));
});
