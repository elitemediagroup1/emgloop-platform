// CallGrid aggregate report contract — Phase 1 instrument tests.
//
// The live probe needs a credential; its SAFETY and CORRECTNESS properties do
// not, and those are what is asserted here. A discovery tool that leaked a
// caller id, or that reported an unreadable envelope as "no activity", would be
// worse than having no discovery tool at all.
//
// Fixtures below are shaped from the DOCUMENTED OpenAPI contract. They are not
// live data and prove nothing about CallGrid's actual values — they exist to
// exercise the instrument.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLGRID_REPORT_CONTRACTS,
  FIELDS_ABSENT_FROM_CONTRACT,
  EXCLUDED_FIELDS,
  extractRows,
  measureNumerics,
  observedNullable,
  redact,
  probeReportContract,
} from '../src/adapters/callgrid-reports';

const contract = (id: string) => CALLGRID_REPORT_CONTRACTS.find((c) => c.id === id)!;

// --- Contract transcription -------------------------------------------------

test('all four verified report endpoints are recorded with their documented methods', () => {
  assert.equal(CALLGRID_REPORT_CONTRACTS.length, 4);
  assert.equal(contract('bidStats').method, 'GET');
  assert.equal(contract('bidRejections').method, 'GET');
  assert.equal(contract('pingStats').method, 'GET');
  // /api/reports/stats is the one POST — a read expressed as a POST.
  assert.equal(contract('callStats').method, 'POST');
});

test('grouping is fixed per endpoint, not configurable', () => {
  // The spec documents NO grouping parameter on the three GET reports. Any
  // buyer/campaign/vendor breakdown must therefore come from elsewhere.
  assert.equal(contract('bidStats').groupingType, 'source');
  assert.equal(contract('pingStats').groupingType, 'destination');
  assert.equal(contract('callStats').groupingType, 'pivot');
  for (const id of ['bidStats', 'bidRejections', 'pingStats']) {
    assert.match(contract(id).groupingNote, /No grouping parameter|not configurable|fixed/i);
  }
});

test('only pingStats documents a `count` envelope key', () => {
  assert.ok(contract('pingStats').envelopeKeys.includes('count'));
  assert.ok(!contract('bidStats').envelopeKeys.includes('count'));
});

test('fields the requirement assumes but the contract does not expose are recorded, not silently dropped', () => {
  const byName = new Map(FIELDS_ABSENT_FROM_CONTRACT.map((f) => [f.requested, f]));
  // The four that decide whether the funnel can be built at all.
  for (const f of ['pings', 'made', 'responseTime', 'duplicatePing']) {
    assert.ok(byName.has(f), `${f} must be recorded`);
    assert.equal(byName.get(f)!.foundInSpec, false, `${f} is absent from the spec`);
  }
  // capped/blocked exist, but on entities — not as report metrics.
  assert.equal(byName.get('capped')!.foundInSpec, true);
  assert.match(byName.get('capped')!.note, /Destination|Buyer/);
  // rateLimited is a PING metric, not a bid metric.
  assert.match(byName.get('rateLimited')!.note, /pingStats/);
  for (const f of FIELDS_ABSENT_FROM_CONTRACT) {
    assert.ok(f.note.length > 40, `${f.requested} must explain itself`);
  }
});

// --- Unknown envelope rejection ---------------------------------------------

test('an unreadable envelope is REJECTED, never reported as an empty report', () => {
  assert.equal(extractRows({ unexpected: 'shape' }, 'data'), null);
  assert.equal(extractRows({ data: 'not-an-array' }, 'data'), null);
  assert.equal(extractRows(null, 'data'), null);
  assert.equal(extractRows({ data: [1, 2, 3] }, 'data'), null, 'rows must be objects');
  // A genuinely empty report IS readable, and is distinct from unreadable.
  const empty = extractRows({ data: [] }, 'data');
  assert.ok(empty);
  assert.equal(empty!.rows.length, 0);
});

test('a probe that cannot read the envelope reports zero rows as null, not 0', async () => {
  const res = await probeReportContract(contract('bidStats'), {
    baseUrl: 'https://example.invalid',
    apiKey: 'test-key',
    startDate: '2026-07-18T00:00:00.000Z',
    endDate: '2026-07-18T23:59:59.999Z',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ surprise: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  });
  assert.equal(res.rowCount, null, 'unknown shape must not produce a row count of 0');
  assert.match(res.note!, /REJECTED/);
  assert.deepEqual(res.envelopeKeys, ['surprise'], 'but the keys are still reported for diagnosis');
});

// --- PII exclusion ----------------------------------------------------------

test('excluded fields are never read, measured, or emitted', () => {
  const rows = [
    { bids: 10, avgBid: 11.09, last5Bids: { callerId: '+12125551234', amount: 42 } },
    { bids: 20, avgBid: 12.5, last5Bids: { callerId: '+13105559876', amount: 7 } },
  ];
  const numerics = measureNumerics(rows);
  const emitted = JSON.stringify(numerics);
  assert.ok(EXCLUDED_FIELDS.includes('last5Bids'));
  assert.ok(!numerics.some((n) => n.field === 'last5Bids'), 'excluded field is not measured');
  assert.doesNotMatch(emitted, /2125551234|3105559876/, 'no caller id can reach the output');
  assert.doesNotMatch(emitted, /callerId/, 'not even the nested key');
  // The legitimate aggregate fields ARE measured.
  assert.ok(numerics.some((n) => n.field === 'bids'));
});

test('the credential is scrubbed from every path that could surface it', () => {
  const key = 'super-secret-key-value';
  const leaked = `fetch failed for https://api.callgrid.com/api/reports/bidStats?apiKey=${key}&page=0`;
  const safe = redact(leaked, key);
  assert.doesNotMatch(safe, /super-secret-key-value/);
  assert.match(safe, /apiKey=\[redacted\]/);
  assert.doesNotMatch(redact('Authorization: Bearer abc123', 'x'), /abc123/);
});

// --- Unit anchoring ---------------------------------------------------------

test('numeric representation is measured, so money units are anchored not assumed', () => {
  // The whole point: `avgBid: number` is undocumented as to unit. Two decimal
  // places and a magnitude near $11 is evidence for dollars; it is NOT proof,
  // which is why this records representation rather than concluding a unit.
  const rows = [{ avgBid: 11.09, totalBidAmount: 585382.56, bids: 274383, winRate: 0.0004 }];
  const m = new Map(measureNumerics(rows).map((n) => [n.field, n]));
  assert.equal(m.get('avgBid')!.maxDecimalPlaces, 2);
  assert.equal(m.get('avgBid')!.allIntegers, false);
  assert.equal(m.get('bids')!.allIntegers, true, 'counts are integers');
  assert.equal(m.get('bids')!.maxDecimalPlaces, 0);
  // A rate below 1 is consistent with a fraction, not a percent. Recorded, not concluded.
  assert.ok(m.get('winRate')!.max < 1);
});

test('observed nullability is measured from data, not taken from the doc', () => {
  const rows = [
    { sourceName: 'A', rated: 5, rejected: null },
    { sourceName: null, rated: 7, rejected: 2 },
  ];
  assert.deepEqual(observedNullable(rows), ['rejected', 'sourceName']);
  // `rated` is documented nullable but was never null here — the doc is not evidence.
  assert.ok(!observedNullable(rows).includes('rated'));
});

// --- Request construction ---------------------------------------------------

test('the probe uses the documented auth transport and never names an organization', async () => {
  let seen = '';
  await probeReportContract(contract('bidStats'), {
    baseUrl: 'https://example.invalid',
    apiKey: 'k',
    startDate: '2026-07-18T00:00:00.000Z',
    endDate: '2026-07-18T23:59:59.999Z',
    fetchImpl: (async (u: string) => {
      seen = u;
      return new Response(JSON.stringify({ data: [], totalPages: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
  assert.match(seen, /apiKey=k/, 'apiKey in query, per the documented securityScheme');
  assert.doesNotMatch(seen, /organizationId/, 'the caller must never name its own organization');
  assert.match(seen, /page=0/, 'paging is documented as ZERO-based');
});

test('pagination defaults are zero-based and bounded', async () => {
  let seen = '';
  await probeReportContract(contract('pingStats'), {
    baseUrl: 'https://example.invalid',
    apiKey: 'k',
    startDate: '2026-07-18T00:00:00.000Z',
    endDate: '2026-07-18T23:59:59.999Z',
    page: 3,
    limit: 50,
    fetchImpl: (async (u: string) => {
      seen = u;
      return new Response(JSON.stringify({ data: [], totalPages: 9, count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
  assert.match(seen, /page=3/);
  assert.match(seen, /limit=50/);
});

test('documented-vs-returned field drift is reported in both directions', async () => {
  const res = await probeReportContract(contract('bidStats'), {
    baseUrl: 'https://example.invalid',
    apiKey: 'k',
    startDate: '2026-07-18T00:00:00.000Z',
    endDate: '2026-07-18T23:59:59.999Z',
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          // `rated` documented but missing; `surpriseField` returned but undocumented.
          data: [{ sourceId: 's1', bids: 5, won: 1, total: 6, surpriseField: 2 }],
          totalPages: 1,
          footerTotals: { bids: 5, won: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
  });
  assert.ok(res.documentedButAbsent!.includes('rated'), 'a documented field that did not arrive is flagged');
  assert.ok(res.undocumentedExtra!.includes('surpriseField'), 'an undocumented field that did arrive is flagged');
  assert.deepEqual(res.footerTotalsKeys, ['bids', 'won']);
  assert.equal(res.totalPages, 1);
});

test('a non-200 response is never mistaken for data', async () => {
  const res = await probeReportContract(contract('bidStats'), {
    baseUrl: 'https://example.invalid',
    apiKey: 'k',
    startDate: '2026-07-18T00:00:00.000Z',
    endDate: '2026-07-18T23:59:59.999Z',
    fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(res.status, 401);
  assert.equal(res.rowCount, null);
  assert.equal(res.rowKeys, null);
});
