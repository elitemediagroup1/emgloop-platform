// CallGrid aggregate report client — the OBSERVED contract, under test.
//
// The contract test one file over asserts what the provider DOCUMENTS. This one
// asserts what the client does with what the provider actually RETURNED on
// 2026-07-18: three envelopes, three grains, and a set of refusals.
//
// The properties worth pinning here are the ones whose failure would be silent:
// an unreadable envelope quietly becoming "no marketplace activity", a null
// metric quietly becoming 0, a caller id quietly reaching a hash we store, or a
// credential quietly reaching a log line. None of those raise an error on their
// own — they just produce a plausible wrong number, which is why they are tested
// rather than reviewed.
//
// Fixtures are shaped from the observed row keys in the source's row types. They
// are not live data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERIFIED_REPORT_PATHS,
  REPORT_GRAIN,
  CallGridReportError,
  parseBidStatsRow,
  parseBidRejectionsRow,
  parsePingStatsRow,
  distinctProviderOrgIds,
  hashPayload,
  scrub,
  fetchReportPage,
  fetchWholeReport,
  CALL_STATS_CONTRACT,
  callStatsRequestBody,
} from '../src/adapters/callgrid-report-client';

const API_KEY = 'super-secret-key-value';

const BASE = {
  baseUrl: 'https://example.invalid',
  apiKey: API_KEY,
  startDate: '2026-07-18T00:00:00.000Z',
  endDate: '2026-07-18T23:59:59.999Z',
};

/** A fetch stub that answers every page with the same body and records the URLs it saw. */
function stub(body: unknown, init: { status?: number; text?: string } = {}) {
  const urls: string[] = [];
  const impl = (async (u: string) => {
    urls.push(u);
    const payload = init.text ?? JSON.stringify(body);
    return new Response(payload, {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

/** A fetch stub that answers page N with bodies[N]. */
function paged(bodies: unknown[]) {
  const urls: string[] = [];
  const impl = (async (u: string) => {
    const page = Number(new URL(u).searchParams.get('page') ?? '0');
    urls.push(u);
    return new Response(JSON.stringify(bodies[page] ?? { data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

// --- Observed envelopes -------------------------------------------------------

const BID_STATS_BODY = {
  data: [
    {
      sourceId: 'src_1',
      sourceName: 'North Side Plumbing',
      total: 274383,
      bids: 39707,
      rated: 12,
      won: 158,
      rejected: 234676,
      totalBidAmount: 585382.56,
      totalWonAmount: 1752.22,
      avgBid: 11.09,
      avgWinningBid: 11.09,
      winRate: 0.3979,
      bidRate: 14.473684,
      rejectRate: 85.526316,
      organizationId: 'cg_org_9',
    },
  ],
  footerTotals: { bids: 39707, won: 158, totalBidAmount: 585382.56 },
  totalPages: 1,
};

const BID_REJECTIONS_BODY = {
  data: [
    {
      sourceId: 'src_1',
      source: { id: 'src_1', name: 'North Side Plumbing' },
      rejected: 234676,
      callerId: 900,
      closed: 12,
      paused: 4,
      duplicate: 71,
      duplicateBids: 8,
      failedAcceptance: 3,
      failedTagRules: 1,
    },
  ],
  footerTotals: { rejected: 234676 },
  totalPages: 1,
};

const PING_STATS_BODY = {
  data: [
    {
      destinationId: 'dst_1',
      destinationName: 'Acme Buyer',
      date: '2026-07-18',
      accepted: 41,
      agents: 3,
      failedAcceptance: 2,
      failedTagRules: 0,
      minRevenue: 9,
      missingAmount: 1,
      invalidNumber: 0,
      durationElapsed: 5,
      pingTimeout: 7,
      apiFailed: 0,
      rateLimited: 2,
      suppressed: 6,
      organizationId: 'cg_org_9',
    },
  ],
  count: 1,
  totalPages: 1,
};

test('all three verified envelopes parse into their grain', async () => {
  const bid = await fetchReportPage('bidStats', { ...BASE, fetchImpl: stub(BID_STATS_BODY).impl });
  const parsedBid = parseBidStatsRow(bid.rows[0]!)!;
  assert.equal(parsedBid.sourceExternalId, 'src_1');
  assert.equal(parsedBid.avgBid, 11.09);
  assert.equal(parsedBid.rejectRate, 85.526316);

  const rej = await fetchReportPage('bidRejections', {
    ...BASE,
    fetchImpl: stub(BID_REJECTIONS_BODY).impl,
  });
  const parsedRej = parseBidRejectionsRow(rej.rows[0]!)!;
  // `callerId` is a COUNT of caller-id rejections. Loop renames it so nobody
  // downstream reads it as an identifier and treats it as PII or a join key.
  assert.equal(parsedRej.callerIdRejected, 900);
  assert.equal(parsedRej.duplicateCaller, 71, 'provider `duplicate`');
  assert.equal(parsedRej.duplicateBids, 8, 'a different field, kept separate');

  const ping = await fetchReportPage('pingStats', { ...BASE, fetchImpl: stub(PING_STATS_BODY).impl });
  const parsedPing = parsePingStatsRow(ping.rows[0]!)!;
  assert.equal(parsedPing.destinationExternalId, 'dst_1');
  assert.equal(parsedPing.rowDate, '2026-07-18');

  // The three grains are recorded as data because the join rule depends on it:
  // source and destination are opposite sides of the marketplace.
  assert.equal(REPORT_GRAIN.bidStats, 'source');
  assert.equal(REPORT_GRAIN.bidRejections, 'source');
  assert.equal(REPORT_GRAIN.pingStats, 'destination');
});

test('parseBidRejectionsRow reads the nested source object, not a flat sourceName', () => {
  // bidStats sends `sourceName`; rejections nests `source: {id, name}`. Reading
  // only the flat key would silently null every rejection row's name and make
  // the two source-grain reports look like different populations.
  const row = parseBidRejectionsRow({
    sourceId: 'src_9',
    source: { id: 'src_9', name: 'Nested Name' },
    rejected: 3,
  })!;
  assert.equal(row.sourceName, 'Nested Name');
  // A row with no id at all is unparseable, and says so with null rather than
  // producing a snapshot keyed on nothing.
  assert.equal(parseBidRejectionsRow({ source: { name: 'orphan' } }), null);
});

// --- Transport ----------------------------------------------------------------

test('the credential travels in the query string and never in a header', async () => {
  let seenInit: RequestInit | undefined;
  const impl = (async (_u: string, init: RequestInit) => {
    seenInit = init;
    return new Response(JSON.stringify(BID_STATS_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const urls: string[] = [];
  const capture = (async (u: string, init: RequestInit) => {
    urls.push(u);
    return impl(u, init);
  }) as unknown as typeof fetch;

  await fetchReportPage('bidStats', { ...BASE, fetchImpl: capture });

  assert.match(urls[0]!, /apiKey=super-secret-key-value/, 'query, per the verified transport');
  const headers = JSON.stringify(seenInit?.headers ?? {});
  assert.doesNotMatch(headers, /super-secret-key-value/, 'never a header');
  assert.doesNotMatch(headers, /[Aa]uthorization/, 'no second auth transport');
  // The caller naming its own organization is the tenancy defect class this repo
  // has already shipped; the provider must resolve it from the credential.
  assert.doesNotMatch(urls[0]!, /organizationId/);
  assert.ok(urls[0]!.startsWith('https://example.invalid' + VERIFIED_REPORT_PATHS.bidStats));
});

test('the date window is passed through verbatim, both bounds inclusive', async () => {
  const s = stub(BID_STATS_BODY);
  await fetchReportPage('bidStats', { ...BASE, fetchImpl: s.impl });
  const q = new URL(s.urls[0]!).searchParams;
  // Verbatim matters: any reformatting here would move the window silently and
  // the provider buckets in a timezone we have not verified.
  assert.equal(q.get('startDate'), '2026-07-18T00:00:00.000Z');
  assert.equal(q.get('endDate'), '2026-07-18T23:59:59.999Z');
  assert.equal(q.get('page'), '0', 'paging is verified ZERO-based');
  assert.equal(q.get('limit'), '100');
});

// --- Pagination ---------------------------------------------------------------

test('totalPages is honoured rather than guessed from an empty page', async () => {
  const p = paged([
    { data: [{ sourceId: 'a', bids: 1 }], totalPages: 2, footerTotals: { bids: 3 } },
    { data: [{ sourceId: 'b', bids: 2 }], totalPages: 2 },
  ]);
  const res = await fetchWholeReport('bidStats', { ...BASE, fetchImpl: p.impl });
  assert.equal(res.pagesFetched, 2);
  assert.equal(res.rows.length, 2);
  assert.equal(res.truncated, false);
  // Zero-based, and page 1 is genuinely requested rather than inferred.
  assert.deepEqual(
    p.urls.map((u) => new URL(u).searchParams.get('page')),
    ['0', '1'],
  );
  // The footer describes the whole report, so it is taken from page 0 only and
  // never accumulated across pages.
  assert.deepEqual(res.footerTotals, { bids: 3 });
});

test('exceeding the page budget sets truncated instead of short-reading silently', async () => {
  const p = paged([
    { data: [{ sourceId: 'a' }], totalPages: 5 },
    { data: [{ sourceId: 'b' }], totalPages: 5 },
  ]);
  const res = await fetchWholeReport('bidStats', { ...BASE, maxPages: 2, fetchImpl: p.impl });
  assert.equal(res.pagesFetched, 2);
  assert.equal(res.totalPages, 5);
  // A truncated report must never be reconciled as if it were complete — three
  // unread pages would present as missing sources, i.e. a fabricated defect.
  assert.equal(res.truncated, true);
});

test('exhausting the budget with no totalPages is truncated, not a clean short read', async () => {
  // A provider that omits totalPages has told us nothing about how many pages
  // exist. Every page here was full, so the budget ran out mid-report — and
  // reporting truncated:false would let a partial report be reconciled as
  // complete, turning unread pages into fabricated missing-source defects.
  const p = paged([{ data: [{ sourceId: 'a' }] }, { data: [{ sourceId: 'b' }] }]);
  const res = await fetchWholeReport('bidStats', { ...BASE, maxPages: 2, fetchImpl: p.impl });
  assert.equal(res.totalPages, null);
  assert.equal(res.pagesFetched, 2);
  assert.equal(res.truncated, true);

  // An empty page IS a terminating condition: the report ended on its own.
  const q = paged([{ data: [{ sourceId: 'a' }] }, { data: [] }]);
  const ended = await fetchWholeReport('bidStats', { ...BASE, maxPages: 5, fetchImpl: q.impl });
  assert.equal(ended.truncated, false);
  assert.equal(ended.rows.length, 1);
});

test('footerTotals is read on every endpoint; count only where the provider sends it', async () => {
  const bid = await fetchReportPage('bidStats', { ...BASE, fetchImpl: stub(BID_STATS_BODY).impl });
  assert.deepEqual(bid.footerTotals, { bids: 39707, won: 158, totalBidAmount: 585382.56 });
  assert.equal(bid.count, null, 'bidStats sends no count key');

  const ping = await fetchReportPage('pingStats', { ...BASE, fetchImpl: stub(PING_STATS_BODY).impl });
  assert.equal(ping.count, 1);
  assert.equal(ping.footerTotals, null, 'pingStats sent no footer here');
});

// --- null is not zero ---------------------------------------------------------

test('a null metric stays null and a zero metric stays zero', () => {
  const nulled = parseBidStatsRow({ sourceId: 's', rated: null, won: 0 })!;
  // Collapsing these is the fabrication defect this platform already shipped
  // once: "the provider did not measure this" rendered as a confident 0.
  assert.equal(nulled.rated, null);
  assert.notEqual(nulled.rated, 0);
  assert.equal(nulled.won, 0);
  const zeroed = parseBidStatsRow({ sourceId: 's', rated: 0 })!;
  assert.equal(zeroed.rated, 0);
  // Absent is also null, not zero.
  assert.equal(parseBidStatsRow({ sourceId: 's' })!.bids, null);
});

// --- Refusals -----------------------------------------------------------------

test('an envelope with no data array is REJECTED, never returned as zero rows', async () => {
  const s = stub({ surprise: true, results: [] });
  await assert.rejects(
    () => fetchReportPage('bidStats', { ...BASE, fetchImpl: s.impl }),
    (e: unknown) => {
      assert.ok(e instanceof CallGridReportError);
      assert.equal(e.classification, 'unknown-envelope');
      // Returning `rows: []` here would render a provider contract change as a
      // quiet day, which is the one failure the run record cannot recover from.
      assert.match(e.message, /REJECTED/);
      assert.match(e.message, /results,surprise/, 'the keys are still reported for diagnosis');
      return true;
    },
  );
});

test('a non-object row inside data is also a rejection, not a skipped row', async () => {
  const s = stub({ data: [{ sourceId: 'a' }, 'not-an-object'], totalPages: 1 });
  await assert.rejects(
    () => fetchReportPage('bidStats', { ...BASE, fetchImpl: s.impl }),
    (e: unknown) =>
      e instanceof CallGridReportError && e.classification === 'unknown-envelope',
  );
});

test('an HTTP failure and an unreadable body are distinct classifications', async () => {
  await assert.rejects(
    () => fetchReportPage('bidStats', { ...BASE, fetchImpl: stub(null, { status: 500, text: 'boom' }).impl }),
    (e: unknown) => {
      assert.ok(e instanceof CallGridReportError);
      assert.equal(e.classification, 'endpoint-failure');
      assert.equal(e.status, 500);
      return true;
    },
  );

  await assert.rejects(
    () => fetchReportPage('bidStats', { ...BASE, fetchImpl: stub(null, { text: '<html>gateway</html>' }).impl }),
    (e: unknown) => {
      assert.ok(e instanceof CallGridReportError);
      // A 200 carrying HTML is a proxy or a login page, not an empty report.
      assert.equal(e.classification, 'malformed-response');
      return true;
    },
  );
});

// --- PII and credentials ------------------------------------------------------

test('last5Bids never survives the boundary, in rows or in the hash', async () => {
  const withPii = {
    data: [
      {
        sourceId: 'src_1',
        bids: 10,
        avgBid: 11.09,
        last5Bids: [{ callerId: '+12125551234', amount: 42 }],
      },
    ],
    totalPages: 1,
  };
  const withoutPii = {
    data: [{ sourceId: 'src_1', bids: 10, avgBid: 11.09 }],
    totalPages: 1,
  };

  const page = await fetchReportPage('bidStats', { ...BASE, fetchImpl: stub(withPii).impl });
  assert.equal('last5Bids' in page.rows[0]!, false, 'dropped at the boundary');
  assert.ok(!page.observedRowKeys.includes('last5Bids'));
  const emitted = JSON.stringify(page);
  assert.doesNotMatch(emitted, /2125551234/, 'no caller id can reach the returned page');
  assert.doesNotMatch(emitted, /callerId/, 'not even the nested key');

  // The hash is stored and compared across syncs. If PII contributed to it, a
  // caller id would be indirectly retained and the hash would also churn on data
  // Loop deliberately does not read.
  const clean = await fetchReportPage('bidStats', { ...BASE, fetchImpl: stub(withoutPii).impl });
  assert.equal(page.payloadHash, clean.payloadHash);
});

test('scrub removes the credential from prose and from a URL query', () => {
  const leaked = `fetch failed for https://api.callgrid.com/api/reports/bidStats?apiKey=${API_KEY}&page=0`;
  const safe = scrub(leaked, API_KEY);
  assert.doesNotMatch(safe, /super-secret-key-value/);
  assert.match(safe, /apiKey=\[redacted\]/);
  assert.match(safe, /page=0/, 'diagnostics that are not secret survive');
  assert.equal(scrub(`token is ${API_KEY} ok`, API_KEY), 'token is [redacted] ok');
});

// --- Hashing ------------------------------------------------------------------

test('hashPayload is deterministic and key-order independent, and moves on a value change', () => {
  // Key order is not part of the provider's contract, so a hash that changed
  // with it would report drift on every sync and become ignored.
  const a = hashPayload({ data: [{ bids: 1, sourceId: 's' }], footerTotals: null });
  const b = hashPayload({ footerTotals: null, data: [{ sourceId: 's', bids: 1 }] });
  assert.equal(a, b);
  assert.equal(a, hashPayload({ data: [{ bids: 1, sourceId: 's' }], footerTotals: null }));
  const c = hashPayload({ data: [{ bids: 2, sourceId: 's' }], footerTotals: null });
  assert.notEqual(a, c, 'a changed value must be visible');
});

// --- Provider org ids ---------------------------------------------------------

test('distinctProviderOrgIds yields provider-side strings, never a Loop tenant key', () => {
  const ids = distinctProviderOrgIds([
    { organizationId: 'cg_org_9' },
    { organizationId: 'cg_org_9' },
    { organizationId: ' cg_org_1 ' },
    { organizationId: 42 },
    {},
  ]);
  // Sorted plain strings, read only to PROVE the provider returned one org's
  // data. If this ever became a Loop organizationId, a provider-side identifier
  // would silently become a tenant boundary.
  assert.deepEqual(ids, ['cg_org_1', 'cg_org_9']);
  for (const id of ids) assert.equal(typeof id, 'string');
  assert.equal(ids.length, 2, 'non-string ids are ignored, not coerced');
});

// --- POST /api/reports/stats — the endpoint that must NOT get built -----------
//
// It returned HTTP 400 live. The risk here is not that someone forgets it; it is
// that someone "fixes" it by guessing a body and wiring it into the funnel,
// giving the two missing stages (`pings`, `made`) a plausible-looking source.

test('callStats is recorded as UNVERIFIED and has no client', () => {
  assert.match(CALL_STATS_CONTRACT.status, /UNVERIFIED/);
  assert.equal(CALL_STATS_CONTRACT.method, 'POST');
  // No 200 was observed, so nothing may be declared required from evidence.
  assert.deepEqual([...CALL_STATS_CONTRACT.documentedRequiredFields], []);
  // The suspected list is a hypothesis to test, and is kept separate from it.
  assert.ok(CALL_STATS_CONTRACT.suspectedRequiredFields.includes('pivot'));
  // It is absent from the endpoints that have a fetch path at all.
  assert.equal(
    Object.keys(VERIFIED_REPORT_PATHS).includes('callStats'),
    false,
    'callStats must not appear among the verified, fetchable endpoints',
  );
});

test('callStats inputs are body-only, which is what explains the live 400', () => {
  const body = callStatsRequestBody({
    startDate: '2026-07-18T00:00:00.000Z',
    endDate: '2026-07-18T23:59:59.999Z',
    pivot: 'SourceName',
  });
  // The three GET reports take these on the query string. This one does not,
  // so a caller reusing the GET convention sends an empty body and gets a 400.
  assert.equal(body['startDate'], '2026-07-18T00:00:00.000Z');
  assert.equal(body['pivot'], 'SourceName');
  assert.equal(body['page'], 0);
  // reportTimeZone is omitted unless asked for — this is the ONLY report
  // endpoint that accepts one, and silently defaulting it would invent a
  // bucketing timezone the other three reports do not have.
  assert.equal('reportTimeZone' in body, false);
  assert.equal(CALL_STATS_CONTRACT.acceptsReportTimeZone, true);
});
