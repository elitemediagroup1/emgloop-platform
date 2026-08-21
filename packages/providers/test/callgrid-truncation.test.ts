// CallGrid pagination truthfulness — proving exhaustion, not assuming it.
//
// THE DEFECT THESE FIXTURES PIN
//
// The old `fetchAllCallGridCalls` ended its loop for two genuinely different
// reasons and returned the same shape for both: the provider said it had no more
// pages, or the page budget ran out while it still did. `poll()` then returned a
// hardcoded `hasMore: false` on top of that, so no layer above could see the
// difference. The visible consequence was a 6,918-call day coming back as a
// clean 2,500 records and being read as the whole day.
//
// WHY THIS FILE STILL EXISTS AFTER THE LOOP IT TESTED WAS DELETED. These are the
// behaviour-preservation fixtures for that migration. The loop moved into
// `readCallGridInterval`; the endings it has to distinguish did not change, and a
// migration that quietly lost one of them would be the same defect returning
// with a new name. The fixture shapes are carried over deliberately.
//
// Nothing here raises the cap. A cap is a safety bound and the reads are still
// bounded; what matters is that the caller learns WHICH ending happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CallGridApiError, fetchCallGridCallsPage } from '../src/adapters/callgrid-api';
import { readCallGridInterval } from '../src/adapters/callgrid-interval';
import { getCallGridProvider } from '../src/index';

const KEY = 'test-key-not-a-real-secret';
const SINCE = new Date('2026-08-12T04:00:00.000Z');
const UNTIL = new Date('2026-08-13T04:00:00.000Z');

/** One CallGrid record with a real occurrence timestamp, so mapping succeeds. */
function rec(id: string) {
  return { id, callStatus: 'completed', UTCUnixTimeMs: SINCE.getTime() + 1000, from: '+12125550100' };
}

/** A provider that always claims another page, with a fresh cursor each time. */
function endlessFetch(perPage = 2) {
  let served = 0;
  return (async () => {
    const data = Array.from({ length: perPage }, (_, i) => rec(`r${served}-${i}`));
    served += 1;
    return new Response(JSON.stringify({ data, hasMore: true, nextCursor: `c${served}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
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

const read = (fetchImpl: typeof fetch, maxPages?: number) =>
  readCallGridInterval({
    apiKey: KEY,
    since: SINCE,
    until: UNTIL,
    fetchImpl,
    sleep: async () => {},
    ...(maxPages ? { maxPages } : {}),
  });

// --- Exhaustion vs budget: the two endings, still distinguished ----------------

test('a provider that runs out of pages is NOT truncated', async () => {
  const result = await read(finiteFetch(3), 10);
  assert.equal(result.outcome, 'COMPLETE', 'the provider ended it, not us');
  assert.equal(result.pages, 3);
  assert.equal(result.records, 6);
  assert.equal(result.events.length, 6);
  assert.equal(result.nextCursor, undefined, 'nothing to resume from');
});

test('a budget reached while the provider still has pages IS truncated', async () => {
  const result = await read(endlessFetch(), 4);
  assert.equal(result.outcome, 'TRUNCATED', 'WE stopped, and that must be visible');
  assert.equal(result.pages, 4, 'the budget bounded it');
  assert.equal(result.pageCap, 4, 'the budget that applied is reported');
  assert.ok(result.nextCursor, 'a truncated read reports where it stopped');
});

test('a single exhausting page is not truncated, however small the budget', async () => {
  // The off-by-one that matters: stopping ON the last page is exhaustion, not a
  // budget hit. Checking the cap before asking the provider would call it
  // truncated and no day would ever certify.
  const result = await read(finiteFetch(1), 1);
  assert.equal(result.outcome, 'COMPLETE');
  assert.equal(result.pages, 1);
});

test('an empty window is a clean, complete read of nothing', async () => {
  const result = await read((async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch);
  // The case a certification records as EMPTY: a PROVEN zero, which is data, as
  // opposed to a day nobody read.
  assert.equal(result.outcome, 'COMPLETE');
  assert.equal(result.records, 0);
  assert.equal(result.events.length, 0);
});

test('the budget that applied is stated rather than implied', async () => {
  const result = await read(finiteFetch(2));
  assert.ok(result.pageCap > 0);
  assert.equal(result.outcome, 'COMPLETE');
});

// --- The adapter reports it upward ---------------------------------------------

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

// --- Failures are classified, not matched on their wording ---------------------
//
// Against the surviving page primitive, which is where these kinds are decided.

test('every provider failure carries a machine-readable kind', async () => {
  const cases: Array<[unknown, number, string]> = [
    [{ error: 'nope' }, 401, 'http-status'],
    [{ unexpected: 'shape' }, 200, 'unrecognised-envelope'],
  ];
  for (const [body, status, kind] of cases) {
    await assert.rejects(
      fetchCallGridCallsPage({
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
    fetchCallGridCallsPage({
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

test('a record with no usable timestamp is REFUSED, not silently dated', async () => {
  // The one behaviour that deliberately changed shape. It used to throw out of
  // the whole page; now the reader partitions it, and `poll()` -- whose callers
  // are completeness gates -- turns the partition back into a refusal. The record
  // is still never dated, never dropped and never counted as mapped.
  const result = await read((async () =>
    new Response(JSON.stringify({ data: [{ id: 'x', callStatus: 'completed' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch);
  assert.equal(result.outcome, 'COMPLETE', 'the FETCH finished');
  assert.equal(result.events.length, 0, 'and nothing was fabricated');
  assert.equal(result.records, 1, 'the provider population is still one record');
  assert.equal(result.refused[0]?.kind, 'no-occurrence');
});

// --- THE ARCHITECTURAL ASSERTION ------------------------------------------------

test('THERE IS EXACTLY ONE CALLGRID MULTI-PAGE LOOP', async () => {
  // The condition PR #183 created deliberately and temporarily: one page
  // primitive, two loops. CLAUDE.md names a parallel system as this repository's
  // defining failure mode, so the state is asserted away rather than remembered.
  const api = readFileSync(new URL('../src/adapters/callgrid-api.ts', import.meta.url), 'utf8');
  const interval = readFileSync(new URL('../src/adapters/callgrid-interval.ts', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../src/adapters/callgrid.provider.ts', import.meta.url), 'utf8');

  const code = (src: string) =>
    src
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  // The deleted loop is gone, not deprecated.
  assert.ok(!code(api).includes('fetchAllCallGridCalls'), 'the old loop must not survive');
  assert.ok(!code(provider).includes('fetchAllCallGridCalls'));

  // Only the interval reader follows a cursor across pages. `poll()` delegates.
  assert.ok(code(interval).includes('readCallGridInterval'));
  assert.ok(code(provider).includes('readCallGridInterval'), 'poll delegates');
  for (const src of [code(api), code(provider)]) {
    assert.ok(!/nextCursor;\s*$/m.test(src) || !src.includes('for (;;)'), 'no second paging loop');
  }
  // One place holds the cursor across iterations.
  const cursorLoops = [code(api), code(interval), code(provider)].filter((s) =>
    /cursor = page\.nextCursor/.test(s),
  );
  assert.equal(cursorLoops.length, 1, 'exactly one loop advances a cursor');
});
