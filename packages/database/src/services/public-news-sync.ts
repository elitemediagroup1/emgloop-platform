import { PUBLIC_NEWS_FEEDS, fetchPublicNews, publicNewsFailure } from '@emgloop/providers';
import type { PrismaClient } from '@prisma/client';
import { PublicNewsRepository } from '../repositories/public-news.repository';
import { absentUntilMigrated } from '../creator/until-migrated';

function storageFailure(error: unknown): 'TRANSACTION_ERROR' | 'POOL_TIMEOUT' | 'PERSISTENCE_FAILED' {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return code === 'P2028' ? 'TRANSACTION_ERROR' : code === 'P2024' ? 'POOL_TIMEOUT' : 'PERSISTENCE_FAILED';
}

/** Background only, under a revalidated operator. Diagnostics contain fixed public source IDs/codes,
 * counts and HTTP status, never response text, URLs, organization IDs or exception messages. */
export async function refreshPublicNews(prisma: PrismaClient, organizationId: string, now: Date, read: typeof fetchPublicNews = fetchPublicNews) {
  return absentUntilMigrated((async () => {
    const repo = new PublicNewsRepository(prisma);
    const markUnavailable = async (sourceId: string) => repo.record(organizationId, sourceId, now, null).then(() => true, () => false);
    // Fixed, bounded fanout. A slow publication does not serialize the other reads.
    const results = await Promise.allSettled(PUBLIC_NEWS_FEEDS.map(async (feed) => {
      const state = await repo.state(organizationId, feed.id);
      if (state && now.getTime() - state.checkedAt.getTime() < 30 * 60_000) return { sourceId: feed.id, status: 'SKIPPED' as const };
      let articles;
      try { articles = await read(feed, now); }
      catch (error) {
        return { sourceId: feed.id, status: 'FAILED' as const, phase: 'READ' as const, ...publicNewsFailure(error), stateRecorded: await markUnavailable(feed.id) };
      }
      try {
        await repo.record(organizationId, feed.id, now, articles);
        return { sourceId: feed.id, status: 'REFRESHED' as const, articleCount: articles.length };
      } catch (error) {
        return { sourceId: feed.id, status: 'FAILED' as const, phase: 'STORE' as const, code: storageFailure(error), stateRecorded: await markUnavailable(feed.id) };
      }
    }));
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    const sources = results.flatMap((r) => r.status === 'fulfilled' ? [r.value] : []);
    return { refreshed: sources.filter((r) => r.status === 'REFRESHED').length, failed: sources.filter((r) => r.status === 'FAILED').length, sources: sources.filter((r) => r.status !== 'SKIPPED') };
  })());
}
