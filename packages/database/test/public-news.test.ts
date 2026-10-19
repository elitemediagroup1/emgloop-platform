import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicNewsArtifacts } from '../src/services/intelligence-fabric/public-news';
import { PUBLIC_NEWS_FEEDS } from '@emgloop/providers';
import { refreshPublicNews } from '../src/services/public-news-sync';
import { PublicNewsReadError } from '@emgloop/providers';
import { PUBLIC_NEWS_WRITE_OPTIONS, PublicNewsRepository } from '../src/repositories/public-news.repository';
const now = new Date('2026-10-16T18:00:00Z');
const internal = [{ ref: 'digest:website', domain: 'WEBSITE', title: 'Website', statement: 'Advertising traffic from Google search increased.', status: 'WATCH', signals: [], basis: 'LOOP_RECORDS', coverage: 'CONNECTED_SUFFICIENT', limitations: [] }] as const;
const article = (sourceId: string, title: string) => ({ id: sourceId, organizationId: 'org', sourceId, publisher: sourceId, title, url: `https://www.ftc.gov/${sourceId}`, publishedAt: new Date('2026-10-16T12:00:00Z'), retrievedAt: now, expiresAt: new Date('2026-11-16') });
const state = (sourceId: string) => ({ id: sourceId, organizationId: 'org', sourceId, checkedAt: now, succeededAt: now, status: 'READY' });
test('outside stories need internal relevance, source health and an actual publication date', () => {
  const snap = { articles: [article('ftc', 'Advertising privacy rules'), article('google-ads', 'Google search updates'), article('search-engine-land', 'Unrelated sports results')], feeds: PUBLIC_NEWS_FEEDS.map((f) => state(f.id)) };
  const result = publicNewsArtifacts(snap, internal, now);
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.gaps[0]?.reason, 'SOURCE_LIMIT', 'limited titles cannot establish complete external coverage');
  assert.ok(result.artifacts.every((a) => a.coverage === 'CONNECTED_PARTIAL' && a.sourceUrl && a.publishedAt && a.limitations.some((l) => l.includes('title only'))));
  const failed = publicNewsArtifacts({ ...snap, feeds: snap.feeds.map((f) => ({ ...f, status: 'ERROR' })) }, internal, now);
  assert.equal(failed.artifacts.length, 0); assert.equal(failed.gaps[0]?.coverage, 'DISCONNECTED');
  assert.equal(publicNewsArtifacts(snap, [], now).artifacts.length, 0);
  assert.equal(publicNewsArtifacts(snap, internal, new Date('2026-10-16T11:00:00Z')).artifacts.length, 0);
});
test('every repository read is explicitly tenant scoped and retention uses publication time', async () => {
  const reads: unknown[] = [];
  const writes: any[] = [];
  const tx = { publicNewsArticle: { upsert: async (q: unknown) => writes.push(q), deleteMany: async (q: unknown) => writes.push(q) }, publicNewsFeedState: { upsert: async (q: unknown) => writes.push(q) } };
  const prisma = { publicNewsArticle: { findMany: async (q: unknown) => { reads.push(q); return []; } }, publicNewsFeedState: { findMany: async (q: unknown) => { reads.push(q); return []; } }, $transaction: async (fn: any, options: unknown) => { assert.deepEqual(options, PUBLIC_NEWS_WRITE_OPTIONS); return fn(tx); } };
  const repo = new PublicNewsRepository(prisma as never);
  await repo.snapshot('org', now);
  for (const q of reads) assert.equal((q as any).where.organizationId, 'org');
  await repo.record('org', 'ftc', now, [article('ftc', 'Advertising privacy')]);
  assert.equal(writes[0].where.organizationId_url.organizationId, 'org');
  assert.equal(writes[0].create.expiresAt.toISOString(), '2026-11-15T12:00:00.000Z');
  await assert.rejects(repo.record('org', 'ftc', now, [article('other', 'bad')]));
});


test('feed diagnostics distinguish publisher reads from storage errors without leaking exception text', async (t) => {
  t.mock.method(PublicNewsRepository.prototype, 'state', async () => null);
  t.mock.method(PublicNewsRepository.prototype, 'record', async (_org: string, id: string, _now: Date, items: unknown) => {
    if (id === PUBLIC_NEWS_FEEDS[1]!.id && items !== null) throw Object.assign(new Error('private database credential'), { code: 'P2028' });
    if (id === PUBLIC_NEWS_FEEDS[2]!.id) throw new Error('private database credential');
  });
  const read = (async (feed: typeof PUBLIC_NEWS_FEEDS[number]) => {
    if (feed.id === PUBLIC_NEWS_FEEDS[0]!.id) throw new PublicNewsReadError('HTTP_ERROR', 503);
    return [];
  }) as never;
  const result = await refreshPublicNews({} as never, 'private-org', now, read);
  assert.ok(result);
  assert.equal(result.refreshed, 2);
  assert.equal(result.failed, 3);
  assert.deepEqual(result.sources[0], { sourceId: PUBLIC_NEWS_FEEDS[0]!.id, status: 'FAILED', phase: 'READ', code: 'HTTP_ERROR', httpStatus: 503, stateRecorded: true });
  assert.deepEqual(result.sources[1], { sourceId: PUBLIC_NEWS_FEEDS[1]!.id, status: 'FAILED', phase: 'STORE', code: 'TRANSACTION_ERROR', stateRecorded: true });
  assert.equal((result.sources[2] as any).stateRecorded, false);
  assert.doesNotMatch(JSON.stringify(result), /private|credential/);
});

test('a recent feed check respects the existing cadence and emits no new source result', async (t) => {
  t.mock.method(PublicNewsRepository.prototype, 'state', async () => state('ftc'));
  let reads = 0, writes = 0;
  t.mock.method(PublicNewsRepository.prototype, 'record', async () => { writes++; });
  const result = await refreshPublicNews({} as never, 'org', now, (async () => { reads++; return []; }) as never);
  assert.deepEqual(result, { refreshed: 0, failed: 0, sources: [] });
  assert.equal(reads, 0); assert.equal(writes, 0);
});
