import type { PrismaClient } from '@prisma/client';
import type { PublicNewsArticle } from '@emgloop/shared';

// Up to 40 bounded metadata upserts share one atomic health update. Five parallel feeds
// get explicit bounded headroom instead of Prisma's five-second transaction default.
export const PUBLIC_NEWS_WRITE_OPTIONS = Object.freeze({ maxWait: 5_000, timeout: 20_000 });

/** Public metadata is still tenant scoped. A successful empty fetch and a failed fetch differ. */
export class PublicNewsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async state(organizationId: string, sourceId: string) {
    return this.prisma.publicNewsFeedState.findUnique({ where: { organizationId_sourceId: { organizationId, sourceId } } });
  }

  async record(organizationId: string, sourceId: string, now: Date, articles: readonly PublicNewsArticle[] | null) {
    await this.prisma.$transaction(async (tx) => {
      if (articles) for (const article of articles) {
        if (article.sourceId !== sourceId) throw new Error('NEWS_SOURCE_MISMATCH');
        const data = { publisher: article.publisher, title: article.title, publishedAt: article.publishedAt, retrievedAt: now, expiresAt: new Date(article.publishedAt.getTime() + 30 * 864e5) };
        await tx.publicNewsArticle.upsert({ where: { organizationId_url: { organizationId, url: article.url } }, create: { organizationId, sourceId, url: article.url, ...data }, update: data });
      }
      await tx.publicNewsFeedState.upsert({ where: { organizationId_sourceId: { organizationId, sourceId } }, create: { organizationId, sourceId, checkedAt: now, succeededAt: articles ? now : null, status: articles ? 'READY' : 'ERROR' }, update: { checkedAt: now, status: articles ? 'READY' : 'ERROR', ...(articles ? { succeededAt: now } : {}) } });
      await tx.publicNewsArticle.deleteMany({ where: { organizationId, expiresAt: { lte: now } } });
    }, PUBLIC_NEWS_WRITE_OPTIONS);
  }

  async snapshot(organizationId: string, now: Date) {
    const [articles, feeds] = await Promise.all([
      this.prisma.publicNewsArticle.findMany({ where: { organizationId, publishedAt: { gte: new Date(now.getTime() - 7 * 864e5), lte: now }, expiresAt: { gt: now } }, orderBy: { publishedAt: 'desc' }, take: 120 }),
      this.prisma.publicNewsFeedState.findMany({ where: { organizationId } }),
    ]);
    return { articles, feeds };
  }
}
