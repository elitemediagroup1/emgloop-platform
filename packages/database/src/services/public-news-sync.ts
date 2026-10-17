import { PUBLIC_NEWS_FEEDS, fetchPublicNews } from '@emgloop/providers';
import type { PrismaClient } from '@prisma/client';
import { PublicNewsRepository } from '../repositories/public-news.repository';
import { absentUntilMigrated } from '../creator/until-migrated';

/** Run only in the background, under a revalidated organization operator. No network during rendering. */
export async function refreshPublicNews(prisma: PrismaClient, organizationId: string, now: Date) {
  return absentUntilMigrated((async () => {
    const repo = new PublicNewsRepository(prisma);
    let refreshed = 0, failed = 0;
    // Fixed five-feed fanout, all requests bounded, so one slow publication does not serialize the others.
    const results = await Promise.allSettled(PUBLIC_NEWS_FEEDS.map(async (feed) => {
      const state = await repo.state(organizationId, feed.id);
      // Persisted cadence survives process restarts; failures retry at the same bounded interval.
      if (state && now.getTime() - state.checkedAt.getTime() < 30 * 60_000) return;
      try { await repo.record(organizationId, feed.id, now, await fetchPublicNews(feed, now)); refreshed++; }
      catch { await repo.record(organizationId, feed.id, now, null); failed++; }
    }));
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    return { refreshed, failed };
  })());
}

