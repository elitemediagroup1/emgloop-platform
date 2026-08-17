// CallGrid pagination truthfulness — proving exhaustion, not assuming it.
//
// THE DEFECT THESE TESTS PIN
//
// `fetchAllCallGridCalls` used to end its loop for two genuinely different
// reasons and return the same shape for both: the provider said it had no more
// pages, or the page budget ran out while it still did. `CallGridProvider.poll`
// then returned a hardcoded `hasMore: false` on top of that, so no layer above
// could see the difference. The visible consequence was a 6,918-call day coming
// back as a clean 2,500 records and being read as the whole day.
//
// Nothing here raises the cap. A cap is a safety bound and the reads are still
// bounded; what changed is that the caller now learns WHICH of the two happened,
// because that is the fact an observation ledger has to record.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchAllCallGridCalls,
  CALLGRID_DEFAULT_MAX_PAGES,
  CallGridApiError,
} from '../src/adapters/callgrid-api';
import { getCallGridProvider } from '../src/index';

const KEY = 'test-key-not-a-real-secret';
const SINCE = new Date('2026-08-12T04:00:00.000Z');
const UNTIL = new Date('2026-08-13T04:00:00.000Z');

/** One CallGrid record with a real occurrence timestamp, so mapping succeeds. */
function rec(id: string) {
  return { id, callStatus: 'completed', UTCUnixTimeMs: SINCE.getTime() + 1000, from: '+12125550100' };
}

/**
 * A provider that always claims another page. The realistic hostile case: we can
 * only ever stop because we chose to, so `truncated` must be true.
 */
function endlessFetch(perPage = 2) {
  let served = 0;
  return {
    calls: () => served,
    impl: (async () => {
      const data = Array.from({ length: perPage }, (_, i) => rec(`r${served++}-${i}`));
      return new Response(JSON.stringify({ data, hasMore: true, nextCursor: `c${served}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  };
}

/** A provider with exactly `pages` pages, the last of which says it is the last. */
function finiteFetch(pages: number, perPage = 2) {
  let page = 0;
  return (async () => {
    page += 1;
    const data = Array.from({ length: perPage }, (_, i) => rec(`p${page}-${i}`));
    const hasMore = page < pages;
    return new Response(
      JSON.stringify({ data, hasMore, ...(hasMore ? { nextCursor: `c${page}` } : {}) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

// --- Exhaustion vs budget ----------------------------------------------------

test('a provider that runs out of pages is NOT truncated', async () => {
  const result = await fetchAllCallGridCalls({
    apiKey: KEY, since: SINCE, until: UNTIL, maxPages: 10, fetchImpl: finiteFetch(3),
  });
  assert.equal(result.truncated, false, 'the provider ended it, not us');
  assert.equal(result.pages, 3);
  assert.equal(result.records, 6);
  assert.equal(result.events.length, 6);
  assert.equal(result.nextCursor, undefined, 'nothing to resume from');
});

test('a budget reached while the provider still has pages IS truncated', async () => {
  const endless = endlessFetch();
  const result = await fetchAllCallGridCalls({
    apiKey: KEY, since: SINCE, until: UNTIL, maxPages: 4, fetchImpl: endless.impl,
  });
  assert.equal(result.truncated, true, 'WE stopped, and that must be visible');
  assert.equal(result.pages, 4, 'the budget bounded it');
  assert.equal(result.pageCap, 4, 'the budget that applied is reported');
  assert.ok(result.nextCursor, 'a truncated read reports where it stopped');
});

test('a single exhausting page is not truncated, however small the budget', async () => {
  // The off-by-one that matters: stopping ON the last page is exhaustion, not a
  // budget hit. Checking the cap before asking the provider would call it
  // truncated and no day would ever certify.
  const result = await fetchAllCallGridCalls({
    apiKey: KEY, since: SINCE, until: UNTIL, maxPages: 1, fetchImpl: finiteFetch(1),
  });
  assert.equal(result.truncated, false);
  assert.equal(result.pages, 1);
});

test('an empty window is a clean, complete read of nothing', async () => {
  const result = await fetchAllCallGridCalls({
    apiKey: KEY,
    since: SINCE,
    until: UNTIL,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  });
  // This is the case a certification records as EMPTY: a PROVEN zero, which is
  // data, as opposed to a day nobody read.
  assert.equal(result.truncated, false);
  assert.equal(result.records, 0);
  assert.equal(result.events.length, 0);
});

test('the default budget is stated rather than implied', async () => {
  const result = await fetchAllCallGridCalls({
    apiKey: KEY, since: SINCE, until: UNTIL, fetchImpl: finiteFetch(2),
  });
  assert.equal(result.pageCap, CALLGRID_DEFAULT_MAX_PAGES);
});

// --- The adapter reports it upward -------------------------------------------

// poll() cannot take an injected fetch, so there is deliberately no test here
// that drives it against a live host: a unit test that reaches the real internet
// is a flake and an outbound call from CI, and the values it would check are
// already proven directly against fetchAllCallGridCalls above. What IS worth
// pinning at this boundary is the branch that never touches the network at all.
test('poll() with no credential polls nothing and claims nothing', async () => {
  const provider = getCallGridProvider();
  const result = await provider.poll(
    { organizationId: 'org-alpha', credentials: {}, config: {} },
    { since: SINCE, until: UNTIL },
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.truncated, false, 'a poll that never ran is not a complete read either');
});

// --- Failures are classified, not matched on their wording -------------------

test('every provider failure carries a machine-readable kind', async () => {
  const cases: Array<[unknown, number, string]> = [
    [{ error: 'nope' }, 401, 'http-status'],
    [{ unexpected: 'shape' }, 200, 'unrecognised-envelope'],
  ];
  for (const [body, status, kind] of cases) {
    await assert.rejects(
      fetchAllCallGridCalls({
        apiKey: KEY,
        since: SINCE,
        until: UNTIL,
        fetchImpl: (async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      }),
      (err: unknown) => {
        assert.ok(err instanceof CallGridApiError);
        assert.equal(err.kind, kind);
        return true;
      },
    );
  }
});

test('a non-JSON body is malformed, never an empty day', async () => {
  await assert.rejects(
    fetchAllCallGridCalls({
      apiKey: KEY,
      since: SINCE,
      until: UNTIL,
      fetchImpl: (async () =>
        new Response('<html>gateway timeout</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
    }),
    (err: unknown) => {
      assert.ok(err instanceof CallGridApiError);
      assert.equal(err.kind, 'non-json');
      return true;
    },
  );
});

test('a record with no usable timestamp is malformed, not silently dated', async () => {
  await assert.rejects(
    fetchAllCallGridCalls({
      apiKey: KEY,
      since: SINCE,
      until: UNTIL,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: 'x', callStatus: 'completed' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    }),
    (err: unknown) => {
      assert.ok(err instanceof CallGridApiError);
      assert.equal(err.kind, 'no-occurrence');
      return true;
    },
  );
});
