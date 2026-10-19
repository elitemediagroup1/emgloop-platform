import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicNewsRss, fetchPublicNews, PUBLIC_NEWS_FEEDS, publicNewsFailure } from '../src/news/public-feeds';
const now = new Date('2026-10-16T18:00:00Z');
const feed = PUBLIC_NEWS_FEEDS[0];
const item = (url = 'https://www.ftc.gov/news/test', date = 'Fri, 16 Oct 2026 12:00:00 GMT') => `<item><title><![CDATA[Advertising &amp; privacy]]></title><link>${url}</link><pubDate>${date}</pubDate><description>Never ingest bodies</description></item>`;
test('public RSS retains attributed metadata, deduplicates and separates publication from retrieval', () => {
  const parsed = parsePublicNewsRss(`<rss><channel>${item()}${item()}</channel></rss>`, feed, now);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.title, 'Advertising & privacy');
  assert.equal(parsed[0]?.publishedAt.toISOString(), '2026-10-16T12:00:00.000Z');
  assert.equal('description' in parsed[0]!, false);
});
test('rejects DTDs, malformed feeds, oversized bodies, offsite/auth URLs, undated, future and old items', () => {
  for (const xml of ['<!DOCTYPE rss><rss></rss>', '<rss>', 'a'.repeat(1_000_001)]) assert.throws(() => parsePublicNewsRss(xml, feed, now));
  for (const [url, date] of [['https://evil.example/article', undefined], ['https://a:b@www.ftc.gov/test', undefined], ['http://www.ftc.gov/test', undefined], [undefined, 'invalid'], [undefined, 'Fri, 30 Oct 2026 12:00:00 GMT'], [undefined, 'Fri, 01 Jan 2021 12:00:00 GMT']]) assert.deepEqual(parsePublicNewsRss(`<rss>${item(url, date)}</rss>`, feed, now), []);
});
test('fetch never follows redirects or sends business context and rejects HTTP failures', async () => {
  let called = false;
  const fetcher = (async (url, init) => { called = true; assert.equal(url, feed.url); assert.equal(init?.redirect, 'error'); assert.equal(init?.body, undefined); return new Response('unavailable', { status: 503 }); }) as typeof fetch;
  await assert.rejects(fetchPublicNews(feed, now, fetcher));
  assert.ok(called);
});


test('fetch errors expose fixed codes and HTTP status, never exception text or response bodies', async () => {
  const cases: [typeof fetch, object][] = [
    [(async () => new Response('private response body', { status: 403 })) as typeof fetch, { code: 'HTTP_ERROR', httpStatus: 403 }],
    [(async () => { throw new DOMException('private timeout URL', 'TimeoutError'); }) as typeof fetch, { code: 'TIMEOUT' }],
    [(async () => { throw new Error('private network URL'); }) as typeof fetch, { code: 'NETWORK_ERROR' }],
    [(async () => new Response('<html>private body</html>')) as typeof fetch, { code: 'INVALID_FEED' }],
    [(async () => new Response(null)) as typeof fetch, { code: 'EMPTY_RESPONSE' }],
    [(async () => new Response('x'.repeat(1_000_001))) as typeof fetch, { code: 'RESPONSE_TOO_LARGE' }],
  ];
  for (const [fetcher, expected] of cases) {
    await assert.rejects(fetchPublicNews(feed, now, fetcher), (error: unknown) => {
      assert.deepEqual(publicNewsFailure(error), expected);
      assert.doesNotMatch(String(error), /private/);
      return true;
    });
  }
});
