// SourceMetricWindowRepository -- the minimized aggregate evidence store for external website sources
// (2026-09-30). One row per (organization, source, subject, dimension value, granularity, window).
//
// WHAT A ROW IS: counts and rates a source reported for a window, the window's finality (PRELIMINARY while the
// source may still revise it) and the quality flags the source attached (sampling, thresholding, roll-up,
// truncation, empty reason, time zone). WHAT IT IS NEVER: a raw provider response, a user, a search query, a
// campaign name. `upsert` refuses any window `websiteSourceWindowProblems` rejects, so the contract is held
// here and not left to a connector.
//
// NULL IS NOT ZERO. A metric the source did not report is stored as JSON null and read back as null; a
// reported 0 stays 0. Nothing here fills a gap.
//
// TENANT-FIRST. Every method takes `organizationId` first. A window may reference a web property only through
// the composite foreign key (webPropertyId, organizationId), so it cannot name another organization's
// property even if a caller passes that id.
//
// Nothing writes here yet -- no connector exists.

import { createHash } from 'crypto';
import type { Prisma, PrismaClient, SourceMetricWindow } from '@prisma/client';
import {
  websiteSourceWindowProblems,
  type SourceMetricValue,
  type WebsiteSourceWindow,
} from '@emgloop/shared';

export type SourceMetricWindowWrite =
  | { readonly outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED'; readonly id: string }
  | { readonly outcome: 'REFUSED'; readonly problems: readonly string[] };

/** A stored window read back, with metrics as the contract types them (number | null). */
export interface StoredSourceMetricWindow {
  readonly id: string;
  readonly sourceId: string;
  readonly webPropertyId: string | null;
  readonly subjectRef: string;
  readonly dimension: string;
  readonly dimensionValue: string;
  readonly granularity: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly finality: string;
  readonly metrics: Readonly<Record<string, SourceMetricValue>>;
  readonly quality: Readonly<Record<string, unknown>>;
  readonly fetchedAt: Date;
}

function contentHash(w: WebsiteSourceWindow): string {
  const metrics = Object.keys(w.metrics).sort().map((k) => [k, w.metrics[k] ?? null]);
  const quality = Object.keys(w.quality).sort().map((k) => [k, (w.quality as unknown as Record<string, unknown>)[k] ?? null]);
  return createHash('sha256').update(JSON.stringify([w.finality, metrics, quality])).digest('hex');
}

function metricsOf(json: Prisma.JsonValue): Record<string, SourceMetricValue> {
  const out: Record<string, SourceMetricValue> = {};
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [k, v] of Object.entries(json)) out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return out;
}

function stored(row: SourceMetricWindow): StoredSourceMetricWindow {
  return {
    id: row.id,
    sourceId: row.sourceId,
    webPropertyId: row.webPropertyId,
    subjectRef: row.subjectRef,
    dimension: row.dimension,
    dimensionValue: row.dimensionValue,
    granularity: row.granularity,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    finality: row.finality,
    metrics: metricsOf(row.metrics),
    quality: row.quality && typeof row.quality === 'object' && !Array.isArray(row.quality) ? (row.quality as Record<string, unknown>) : {},
    fetchedAt: row.fetchedAt,
  };
}

export class SourceMetricWindowRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Store or refresh one window. An unchanged re-fetch is UNCHANGED (only `fetchedAt` moves). A window already
   * FINAL is never overwritten by a PRELIMINARY one -- a late partial read does not undo a settled figure.
   */
  async upsert(
    organizationId: string,
    webPropertyId: string | null,
    w: WebsiteSourceWindow,
    fetchedAt: Date,
  ): Promise<SourceMetricWindowWrite> {
    const problems = websiteSourceWindowProblems(w);
    if (problems.length > 0) return { outcome: 'REFUSED', problems };
    if (webPropertyId) {
      const own = await this.prisma.webProperty.findFirst({ where: { id: webPropertyId, organizationId }, select: { id: true } });
      if (!own) return { outcome: 'REFUSED', problems: ['PROPERTY_NOT_IN_ORGANIZATION'] };
    }
    const hash = contentHash(w);
    const where = {
      organizationId_sourceId_subjectRef_dimension_dimensionValue_granularity_windowStart_windowEnd: {
        organizationId,
        sourceId: w.sourceId,
        subjectRef: w.subjectRef,
        dimension: w.dimension,
        dimensionValue: w.dimensionValue,
        granularity: w.granularity,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      },
    };
    const existing = await this.prisma.sourceMetricWindow.findUnique({ where, select: { id: true, contentHash: true, finality: true } });
    if (existing) {
      if (existing.contentHash === hash || (existing.finality === 'FINAL' && w.finality === 'PRELIMINARY')) {
        await this.prisma.sourceMetricWindow.update({ where: { id: existing.id }, data: { fetchedAt } });
        return { outcome: 'UNCHANGED', id: existing.id };
      }
      await this.prisma.sourceMetricWindow.update({
        where: { id: existing.id },
        data: { finality: w.finality, metrics: w.metrics as Prisma.InputJsonValue, quality: w.quality as unknown as Prisma.InputJsonValue, contentHash: hash, fetchedAt },
      });
      return { outcome: 'UPDATED', id: existing.id };
    }
    const row = await this.prisma.sourceMetricWindow.create({
      data: {
        organizationId,
        webPropertyId,
        sourceId: w.sourceId,
        subjectRef: w.subjectRef,
        dimension: w.dimension,
        dimensionValue: w.dimensionValue,
        granularity: w.granularity,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
        finality: w.finality,
        metrics: w.metrics as Prisma.InputJsonValue,
        quality: w.quality as unknown as Prisma.InputJsonValue,
        contentHash: hash,
        fetchedAt,
      },
      select: { id: true },
    });
    return { outcome: 'CREATED', id: row.id };
  }

  /** This organization's windows for a source that END within [since, until). */
  async windows(organizationId: string, sourceId: string, since: Date, until: Date): Promise<StoredSourceMetricWindow[]> {
    const rows = await this.prisma.sourceMetricWindow.findMany({
      where: { organizationId, sourceId, windowEnd: { gt: since, lte: until } },
      orderBy: [{ windowEnd: 'asc' }, { dimension: 'asc' }, { dimensionValue: 'asc' }],
    });
    return rows.map(stored);
  }

  /** The newest window per source for this organization (diagnostics): its end, finality and quality flags. */
  async newestBySource(organizationId: string, sourceIds: readonly string[]): Promise<Map<string, StoredSourceMetricWindow>> {
    const out = new Map<string, StoredSourceMetricWindow>();
    for (const sourceId of sourceIds) {
      const row = await this.prisma.sourceMetricWindow.findFirst({
        where: { organizationId, sourceId },
        orderBy: [{ windowEnd: 'desc' }, { id: 'asc' }],
      });
      if (row) out.set(sourceId, stored(row));
    }
    return out;
  }

  /** Delete windows that ended before the cutoff (retention). Across organizations: a sweep, not a read. */
  async purgeEndedBefore(cutoff: Date): Promise<{ purged: number }> {
    const { count } = await this.prisma.sourceMetricWindow.deleteMany({ where: { windowEnd: { lt: cutoff } } });
    return { purged: count };
  }
}
