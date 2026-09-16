// Universal Activity, composed -- the read model.
//
// Slice A2 (docs/architecture/universal-activity.md). This is the projection, and
// projection is all it is: it owns no table, writes nothing, caches nothing, and
// holds no opinion about any fact. Every item it returns belongs to the authority
// that produced it, and every authority is read under its own guard.
//
// COMPOSITION IS BOUNDED. Each adapter is asked for at most `limit + 1` items
// strictly after the cursor, using its own index. The merge then takes the first
// `limit` of them -- the k-way merge property means an item no adapter returned is
// older than every adapter's last returned item, so it cannot belong on this page.
// Nothing here loads a source "and sorts it".
//
// AN ADAPTER THE VIEWER MAY NOT READ IS NOT RUN. The service decides that before
// this repository is called, so an unauthorized source costs no query and appears
// only as a skipped source in the diagnostics.
//
// WHAT IT REFUSES TO SHOW. Every item is re-validated against `activity.v1` by its
// adapter before it leaves. An item that would invent identity, hide unknown time,
// dress interpretation as fact or carry a contact value in its title is refused --
// a short page is always better than a wrong one.

import type { PrismaClient } from '@prisma/client';
import {
  ACTIVITY_CONTRACT_VERSION,
  ACTIVITY_PAGE_LIMIT_DEFAULT,
  activityCursorOf,
  activityPageLimit,
  mergeActivityStreams,
  type ActivityFilter,
  type ActivityPageV1,
  type ActivitySourceReadV1,
} from '@emgloop/shared';

import {
  decodeActivityCursor,
  encodeActivityCursor,
  type ActivityAdapter,
  type ActivitySubject,
} from './activity/adapter';
import { AuditActivityAdapter } from './activity/audit.adapter';
import { InteractionActivityAdapter } from './activity/interaction.adapter';
import { MarketplaceCallActivityAdapter } from './activity/marketplace-call.adapter';
import { MessageActivityAdapter } from './activity/message.adapter';
import { ObservationActivityAdapter } from './activity/observation.adapter';
import { WorkActivityAdapter } from './activity/work.adapter';

export { ActivityCursorError } from './activity/adapter';
export type { ActivityAdapter, ActivitySubject } from './activity/adapter';

export interface ActivityReadOptions {
  readonly filter?: ActivityFilter;
  readonly cursor?: string | null;
  readonly limit?: number | null;
}

export interface ActivityReadModelDeps {
  /** Overridden in tests; production composes the five real adapters below. */
  adapters?: readonly ActivityAdapter[];
}

export class ActivityReadModelRepository {
  private readonly adapters: readonly ActivityAdapter[];

  constructor(prisma: PrismaClient, deps: ActivityReadModelDeps = {}) {
    this.adapters =
      deps.adapters ?? [
        new InteractionActivityAdapter(prisma),
        new MarketplaceCallActivityAdapter(prisma),
        new ObservationActivityAdapter(prisma),
        new MessageActivityAdapter(prisma),
        new AuditActivityAdapter(prisma),
        new WorkActivityAdapter(prisma),
      ];
  }

  /** Every adapter that can say anything about this subject, authorized or not. */
  adaptersFor(subject: ActivitySubject): readonly ActivityAdapter[] {
    return this.adapters.filter((adapter) => adapter.supports(subject));
  }

  /**
   * One page of the subject's activity, from the adapters the caller has already
   * established the viewer may read. `skipped` names the rest, so a caller can tell
   * "nothing happened" from "you cannot see that source" without being told which.
   */
  async page(
    organizationId: string,
    subject: ActivitySubject,
    permitted: readonly ActivityAdapter[],
    options: ActivityReadOptions = {},
    skipped: readonly ActivitySourceReadV1[] = [],
  ): Promise<ActivityPageV1> {
    const limit = activityPageLimit(options.limit ?? ACTIVITY_PAGE_LIMIT_DEFAULT);
    const cursor = options.cursor ? decodeActivityCursor(options.cursor) : null;
    const filter: ActivityFilter = options.filter ?? 'ALL';
    const interactionsIncluded = permitted.some((a) => a.domain === 'channel');

    const pages = await Promise.all(
      permitted.map(async (adapter) => {
        const page = await adapter.page({ organizationId, subject, filter, cursor, limit, interactionsIncluded });
        return { adapter, page };
      }),
    );

    const merged = mergeActivityStreams(
      pages.map(({ page }) => page.items),
      limit,
    );
    const last = merged.items[merged.items.length - 1];

    const sources: ActivitySourceReadV1[] = [
      ...pages.map(({ adapter, page }) => ({
        domain: adapter.domain,
        rowsRead: page.rowsRead,
        refused: page.rowsRead - page.items.length - page.suppressed,
        suppressed: page.suppressed,
        skipped: null,
        limitations: page.limitations,
      })),
      ...skipped,
    ];

    return {
      contractVersion: ACTIVITY_CONTRACT_VERSION,
      items: merged.items,
      nextCursor: merged.hasMore && last ? encodeActivityCursor(activityCursorOf(last)) : null,
      sources,
    };
  }
}
