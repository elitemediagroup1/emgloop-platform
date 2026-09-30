// Raw website telemetry retention (WEBSITE_RAW_TELEMETRY, @emgloop/shared website-evidence.ts) -- DEFINED, and
// run only when the worker's LOOP_WEBSITE_TELEMETRY_RETENTION is 'on' (off by default; nothing sets it).
//
// WHAT IT CAN NEVER DELETE: a Pipeline WEB_LEAD. IntakeEligibilityRepository establishes a WEB_LEAD from a
// Customer row (metadata.createdFrom = 'website', not an anonymous `web-visitor:`), and dates its entry from the
// earliest website FORM_SUBMISSION interaction ATTACHED to that Customer (customerId = the lead). This purge
// touches no Customer row and selects only interactions with customerId IS NULL -- so neither the lead nor its
// submission is ever a candidate. (Website ingestion attaches no Person: every telemetry row it writes is
// customerId NULL, which is exactly what is purgeable.)
//
// Bounded batches, oldest first; counts only are returned.

import type { PrismaClient } from '@prisma/client';

const BATCH = 1_000;

export class WebsiteTelemetryRetentionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Delete raw website telemetry older than `cutoff`, at most `maxBatches` batches of each table per call. */
  async purgeBefore(cutoff: Date, maxBatches = 20): Promise<{ interactions: number; integrationEvents: number }> {
    let interactions = 0;
    let integrationEvents = 0;
    for (let i = 0; i < maxBatches; i++) {
      const ids = await this.prisma.interaction.findMany({
        where: { provider: 'website', customerId: null, occurredAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { occurredAt: 'asc' },
        take: BATCH,
      });
      if (ids.length === 0) break;
      const { count } = await this.prisma.interaction.deleteMany({ where: { id: { in: ids.map((r) => r.id) }, customerId: null } });
      interactions += count;
      if (ids.length < BATCH) break;
    }
    for (let i = 0; i < maxBatches; i++) {
      const ids = await this.prisma.integrationEvent.findMany({
        where: { provider: 'website', receivedAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { receivedAt: 'asc' },
        take: BATCH,
      });
      if (ids.length === 0) break;
      const { count } = await this.prisma.integrationEvent.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
      integrationEvents += count;
      if (ids.length < BATCH) break;
    }
    return { interactions, integrationEvents };
  }
}
