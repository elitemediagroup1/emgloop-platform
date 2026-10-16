import { createHash } from 'node:crypto';
import { PUBLIC_NEWS_FEEDS, fetchPublicNews } from '@emgloop/providers';
import type { PrismaClient } from '@prisma/client';
import { PublicNewsRepository } from '../../repositories/public-news.repository';
import { absentUntilMigrated } from '../../creator/until-migrated';
import type { BriefingArtifact, BriefingGap } from './briefing';

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

const STOP_WORDS = new Set(['with','from','this','that','have','were','been','calls','reported','today','current','reading','there','their','which','about','would','could','might','after','before','unknown','source','sources','revenue','weekly']);
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)));

/** Local relevance ranking, never a private query sent to a publisher. Titles are claims, not facts. */
export function publicNewsArtifacts(snapshot: Awaited<ReturnType<PublicNewsRepository['snapshot']>> | null, internal: readonly BriefingArtifact[], now: Date): { artifacts: BriefingArtifact[]; gaps: BriefingGap[] } {
  const live = new Set(snapshot?.feeds.filter((f) => f.status === 'READY' && f.succeededAt && now >= f.succeededAt && now.getTime() - f.succeededAt.getTime() < 2 * 3600_000).map((f) => f.sourceId));
  const gaps: BriefingGap[] = live.size === PUBLIC_NEWS_FEEDS.length ? [{ domain: 'EXTERNAL_NEWS', coverage: 'CONNECTED_PARTIAL', reason: 'SOURCE_LIMIT' }] : [{ domain: 'EXTERNAL_NEWS', coverage: live.size ? 'CONNECTED_PARTIAL' : 'DISCONNECTED', reason: live.size ? 'NOT_CURRENT' : 'NOT_CONNECTED' }];
  const vocabulary = words(internal.map((a) => `${a.title} ${a.statement} ${a.signals.map((s) => s.statement).join(' ')}`).join(' '));
  const ranked = (snapshot?.articles ?? []).filter((a) => live.has(a.sourceId) && a.publishedAt <= now && now.getTime() - a.publishedAt.getTime() < 7 * 864e5).map((a) => ({ a, score: [...words(a.title)].filter((w) => vocabulary.has(w)).length })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || b.a.publishedAt.getTime() - a.a.publishedAt.getTime());
  const used = new Set<string>();
  const artifacts: BriefingArtifact[] = [];
  for (const { a } of ranked) {
    if (artifacts.length >= 3 || used.has(a.sourceId)) continue;
    used.add(a.sourceId);
    artifacts.push({ ref: `news:${a.id}`, domain: 'EXTERNAL_NEWS', title: `${a.publisher} · publication ${a.publishedAt.toISOString().slice(0, 10)}`, statement: a.title, status: 'CALM', signals: [], basis: createHash('sha256').update(JSON.stringify([a.sourceId, a.title, a.url, a.publishedAt])).digest('hex'), sourceUrl: a.url, publishedAt: a.publishedAt.toISOString(), generatedAt: a.retrievedAt.toISOString(), windowStart: a.publishedAt.toISOString(), windowEnd: a.publishedAt.toISOString(), coverage: 'CONNECTED_PARTIAL', limitations: ['Public feed title only; article body and applicability to this business have not been verified. Other publications and LinkedIn posts are not covered.'] });
  }
  return { artifacts, gaps };
}

export async function readPublicNews(prisma: PrismaClient, organizationId: string, internal: readonly BriefingArtifact[], now: Date) {
  const snapshot = await absentUntilMigrated(new PublicNewsRepository(prisma).snapshot(organizationId, now)).catch(() => null);
  return publicNewsArtifacts(snapshot, internal, now);
}
