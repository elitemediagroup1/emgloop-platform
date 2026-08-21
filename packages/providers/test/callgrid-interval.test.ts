// Bounded, complete CallGrid interval retrieval.
//
// THE ONE PROPERTY EVERYTHING ELSE SERVES: a caller must never be able to
// mistake a partial read for a whole one. A loop can end for six reasons and
// only `COMPLETE` means the interval is in hand — so every other ending is a
// named outcome, and a checkpoint may only ever advance on the one.
//
// The fixtures are shaped from real production volume. 2026-08-11 held 4,239
// CallGrid calls, which is 43 pages at 100 per page — well past the 25-page
// budget the old reader carried, and the reason a "complete" read of that day
// used to be 2,500 records.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERVAL_MAX_SPAN_DAYS,
  INTERVAL_READ_OUTCOMES,
  intervalWasComplete,
  readCallGridInterval,
  retryAfterMs,
  validateInterval,
} from '../src/adapters/callgrid-interval';

const SINCE = new Date('2026-08-11T04:00:00.000Z');
const UNTIL = new Date('2026-08-12T04:00:00.000Z');

/** A well-formed CallGrid record: real id, real occurrence. */
const record = (n: number) => ({
  id: `call-${n}`,
  UTCUnixTimeMs: SINCE.getTime() + n * 1000,
  callStatus: 'COMPLETED',
  CallRevenue: '0',
});

interface StubPage {
  records: Array<Record<string, unknown>>;
  nextCursor?: unknown;
  hasMore?: boolean;
  totalCount?: number;
  status?: number;
  retryAfter?: string;
  body?: unknown;
}

/** A fetch double that serves a scripted sequence of pages. */
function provider(pages: StubPage[]) {
  const calls: Array<{ url: string }> = [];
  let i = 0;
  const fetchImpl = (async (url: string) => {
    calls.push({ url: String(url) });
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    if (page?.status && page.status >= 400) {
      return {
        ok: false,
        status: page.status,
        headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? (page.retryAfter ?? null) : null) },
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () =>
        page?.body ?? {
          data: page?.records ?? [],
          ...(page?.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          ...(page?.hasMore === undefined ? {} : { hasMore: page.hasMore }),
          ...(page?.totalCount === undefined ? {} : { totalCount: page.totalCount }),
        },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const read = (pages: StubPage[], over: Record<string, unknown> = {}) =>
  readCallGridInterval({
    apiKey: 'test-key',
    since: SINCE,
    until: UNTIL,
    fetchImpl: provider(pages).fetchImpl,
    sleep: async () => {},
    ...over,
  });

// --- 1, 2, 3: the bounded interval contract -------------------------------------------

test('1. an explicit since/until interval reads and reports COMPLETE', async () => {
  const r = await read([{ records: [record(1), record(2)], hasMore: false }]);
  assert.equal(r.outcome, 'COMPLETE');
  assert.equal(intervalWasComplete(r), true);
  assert.equal(r.events.length, 2);
  assert.equal(r.since, SINCE);
  assert.equal(r.until, UNTIL);
});

test('2. equal and reversed bounds are REFUSED before any provider request', async () => {
  const stub = provider([{ records: [record(1)], hasMore: false }]);
  for (const [since, until] of [
    [SINCE, SINCE],
    [UNTIL, SINCE],
  ] as Array<[Date, Date]>) {
    const r = await readCallGridInterval({ apiKey: 'k', since, until, fetchImpl: stub.fetchImpl });
    assert.equal(r.outcome, 'REFUSED');
    assert.match(r.reason ?? '', /EXCLUSIVE/);
  }
  assert.equal(stub.calls.length, 0, 'nothing was requested');
  assert.equal(validateInterval(SINCE, SINCE).ok, false);
});

test('2b. an oversized interval is REFUSED, never quietly truncated', async () => {
  const far = new Date(SINCE.getTime() + (INTERVAL_MAX_SPAN_DAYS + 1) * 86_400_000);
  const r = await read([{ records: [], hasMore: false }], { until: far });
  assert.equal(r.outcome, 'REFUSED');
  assert.match(r.reason ?? '', /smaller intervals/);
});

test('3. the interval is HALF-OPEN, and the exclusive bound reaches the provider as such', async () => {
  const stub = provider([{ records: [], hasMore: false }]);
  await readCallGridInterval({ apiKey: 'k', since: SINCE, until: UNTIL, fetchImpl: stub.fetchImpl });
  const url = new URL(stub.calls[0]!.url);
  assert.equal(url.searchParams.get('startDate'), SINCE.toISOString());
  // CallGrid's filter is inclusive on both ends, so the exclusive upper bound is
  // one millisecond earlier. Without this two adjacent intervals both claim a
  // call landing exactly on the boundary.
  assert.equal(url.searchParams.get('endDate'), new Date(UNTIL.getTime() - 1).toISOString());
});

test('3b. there is no clock inside the reader — `until` is required', async () => {
  // A default of now() would make the same request return different populations
  // depending on when it ran, which is the opposite of rerunnable.
  const source = (await import('node:fs')).readFileSync(
    new URL('../src/adapters/callgrid-interval.ts', import.meta.url),
    'utf8',
  );
  const code = source
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  assert.ok(!/new Date\(\)/.test(code.replace(/Date\.now\(\)/g, '')), 'no implicit now()');
});

// --- 4, 5, 6: complete pagination ------------------------------------------------------

test('4/5. THE AUGUST 11 SHAPE: 4,239 records over 43 pages, complete, not truncated', async () => {
  const pages: StubPage[] = [];
  let remaining = 4239;
  let n = 0;
  while (remaining > 0) {
    const size = Math.min(100, remaining);
    remaining -= size;
    pages.push({
      records: Array.from({ length: size }, () => record(n++)),
      ...(remaining > 0 ? { nextCursor: `cur-${pages.length}`, hasMore: true } : { hasMore: false }),
    });
  }
  assert.equal(pages.length, 43, 'the fixture really is past the old 25-page budget');

  const r = await read(pages);
  assert.equal(r.outcome, 'COMPLETE');
  assert.equal(r.records, 4239);
  assert.equal(r.events.length, 4239);
  assert.equal(r.pages, 43);
});

test('6. the final page terminates the loop, and the cursor is not carried past it', async () => {
  const r = await read([
    { records: [record(1)], nextCursor: 'a', hasMore: true },
    { records: [record(2)], hasMore: false },
  ]);
  assert.equal(r.outcome, 'COMPLETE');
  assert.equal(r.nextCursor, undefined);
  assert.equal(r.pages, 2);
});

test('the page budget is TRUNCATED, never COMPLETE', async () => {
  // Distinct cursors per page, so the BUDGET is what stops this and not the
  // repeated-cursor guard — the two endings are different findings and the
  // fixture has to be able to tell them apart.
  const endless = Array.from({ length: 10 }, (_, i) => ({
    records: [record(i)],
    nextCursor: `cur-${i}`,
    hasMore: true,
  }));
  const r = await read(endless, { maxPages: 3 });
  assert.equal(r.outcome, 'TRUNCATED');
  assert.equal(intervalWasComplete(r), false);
  assert.equal(r.pages, 3);
  assert.ok(r.nextCursor, 'and it says where to resume');
  assert.match(r.reason ?? '', /lower bound/);
});

// --- 7, 8: pagination pathologies fail closed --------------------------------------------

test('7. a repeated cursor is INVALID_PAGINATION, not an endless loop', async () => {
  const r = await read([{ records: [record(1)], nextCursor: 'same', hasMore: true }], { maxPages: 50 });
  assert.equal(r.outcome, 'INVALID_PAGINATION');
  assert.match(r.reason ?? '', /already returned/);
  assert.ok(r.pages < 50, 'it stopped on the repeat, not on the budget');
});

test('8. hasMore with no cursor is INVALID_PAGINATION, never treated as the end', async () => {
  const r = await read([{ records: [record(1)], hasMore: true }]);
  assert.equal(r.outcome, 'INVALID_PAGINATION');
  assert.match(r.reason ?? '', /no cursor/);
});

// --- 9, 10, 11, 12: throttling -------------------------------------------------------------

test('9. a 429 is retried and the interval still completes', async () => {
  let served = 0;
  const fetchImpl = (async () => {
    served += 1;
    if (served <= 2) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: [record(1)], hasMore: false }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const r = await readCallGridInterval({
    apiKey: 'k',
    since: SINCE,
    until: UNTIL,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(r.outcome, 'COMPLETE');
  assert.equal(r.rateLimitRetries, 2);
});

test('10. Retry-After is honoured when the provider supplies one', async () => {
  const waited: number[] = [];
  let served = 0;
  const fetchImpl = (async () => {
    served += 1;
    if (served === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '7' : null) },
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: [], hasMore: false }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  await readCallGridInterval({
    apiKey: 'k',
    since: SINCE,
    until: UNTIL,
    fetchImpl,
    sleep: async (ms) => {
      waited.push(ms);
    },
  });
  assert.deepEqual(waited, [7000], 'the provider was obeyed, not second-guessed');
  // And the header parser handles both forms, and never sleeps backwards.
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('not-a-date'), null);
  assert.ok((retryAfterMs(new Date(Date.now() - 60_000).toUTCString()) ?? -1) >= 0);
});

test('11. retry exhaustion is RATE_LIMIT_EXHAUSTED and can never read as complete', async () => {
  const r = await read([{ records: [], status: 429 }], { maxRateLimitRetries: 2 });
  assert.equal(r.outcome, 'RATE_LIMIT_EXHAUSTED');
  assert.equal(intervalWasComplete(r), false);
  assert.equal(r.rateLimitRetries, 3, 'the budget plus the attempt that exceeded it');
  assert.match(r.reason ?? '', /not fully read/);
});

test('12. a non-429 provider failure is NOT retried', async () => {
  let served = 0;
  const fetchImpl = (async () => {
    served += 1;
    return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await readCallGridInterval({
    apiKey: 'k',
    since: SINCE,
    until: UNTIL,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(r.outcome, 'PROVIDER_ERROR');
  assert.equal(served, 1, 'retrying a contract defect turns one bad answer into five');
  assert.equal(r.rateLimitRetries, 0);
});

test('12b. an unrecognised envelope is a PROVIDER_ERROR, never an empty interval', async () => {
  const r = await read([{ records: [], body: { unexpected: true } }]);
  assert.equal(r.outcome, 'PROVIDER_ERROR');
  assert.equal(r.events.length, 0);
});

// --- 13, 14, 15: malformed records ----------------------------------------------------------

test('13/15. A COMPLETE READ MAY CONTAIN A REFUSED RECORD, and the two are distinguishable', async () => {
  // "CallGrid omitted data" and "CallGrid returned 4,239 records and one cannot
  // be mapped" are different incidents. One record must not cost the other 4,238.
  const noId = { UTCUnixTimeMs: SINCE.getTime(), callStatus: 'COMPLETED' };
  const noTime = { id: 'call-x', callStatus: 'COMPLETED' };
  const r = await read([{ records: [record(1), noId, noTime, record(2)], hasMore: false }]);

  assert.equal(r.outcome, 'COMPLETE', 'the FETCH was complete');
  assert.equal(r.records, 4, 'all four were returned by the provider');
  assert.equal(r.events.length, 2, 'two mapped');
  assert.equal(r.refused.length, 2, 'two did not, and are reported');
  assert.deepEqual(
    r.refused.map((x) => x.kind).sort(),
    ['no-identity', 'no-occurrence'],
    'each says which contract refused it',
  );
  assert.ok(r.refused.every((x) => x.page === 1), 'and where to find it');
});

test('14. a malformed identity is still REFUSED and never fabricated', async () => {
  const r = await read([{ records: [{ UTCUnixTimeMs: SINCE.getTime() }], hasMore: false }]);
  assert.equal(r.events.length, 0);
  assert.match(r.refused[0]!.reason, /no usable call id/);
  assert.ok(!JSON.stringify(r).includes('callgrid-'), 'no synthetic id anywhere in the result');
});

// --- 16: rerunnable ---------------------------------------------------------------------------

test('16. the same interval rerun produces the same population, in the same order', async () => {
  const pages: StubPage[] = [
    { records: [record(1), record(2)], nextCursor: 'a', hasMore: true },
    { records: [record(3)], hasMore: false },
  ];
  const first = await read(pages);
  const second = await read(pages);
  assert.equal(first.outcome, second.outcome);
  assert.deepEqual(
    first.events.map((e) => e.externalId),
    second.events.map((e) => e.externalId),
  );
  assert.deepEqual(first.events.map((e) => e.externalId), ['call-1', 'call-2', 'call-3']);
});

// --- 17-21: the reader writes nothing and schedules nothing --------------------------------------

test('17-21. fetching writes nothing, advances nothing and schedules nothing', async () => {
  const source = (await import('node:fs')).readFileSync(
    new URL('../src/adapters/callgrid-interval.ts', import.meta.url),
    'utf8',
  );
  const code = source
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  for (const symbol of [
    'IntegrationEvent',
    'MarketplaceCall',
    'prisma',
    'IngestionService',
    'ingest(',
    'checkpoint',
    'watermark',
    'lastSyncedAt',
    'setInterval',
    'cron',
    'schedule',
    'recover',
    'reconcile',
    'assessReadiness',
    'measureChange',
  ]) {
    assert.ok(!code.includes(symbol), `the reader must not reference ${symbol}`);
  }
});

test('the outcome vocabulary is closed, and exactly one member means success', () => {
  assert.deepEqual(
    [...INTERVAL_READ_OUTCOMES],
    ['COMPLETE', 'TRUNCATED', 'RATE_LIMIT_EXHAUSTED', 'PROVIDER_ERROR', 'INVALID_PAGINATION', 'REFUSED'],
  );
  for (const outcome of INTERVAL_READ_OUTCOMES) {
    const complete = intervalWasComplete({ outcome } as never);
    assert.equal(complete, outcome === 'COMPLETE', `${outcome} must ${outcome === 'COMPLETE' ? '' : 'not '}certify`);
  }
});

test('a provider total is reported beside the fetched count, and certifies nothing', async () => {
  const r = await read([{ records: [record(1)], hasMore: false, totalCount: 999 }]);
  assert.equal(r.outcome, 'COMPLETE', 'the provider proved exhaustion; its total did not');
  assert.equal(r.providerTotal, 999);
  assert.equal(r.events.length, 1, 'the discrepancy is visible rather than resolved');
});
