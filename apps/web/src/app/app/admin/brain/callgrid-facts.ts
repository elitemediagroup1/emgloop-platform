import 'server-only';

// Executive Briefing — call fact loader (now reads the MarketplaceCall projection).
//
// Per the MarketplaceCall foundation: the Intelligence layer reads the
// normalized, first-class projection instead of parsing Interaction.metadata
// JSON at request time. Metadata parsing now lives ONLY in the projection mapper
// (the transformation layer), not here.
//
// Fallback / backfill (idempotent): if the projection has no rows for the window
// yet, we project the existing Interactions for that window into MarketplaceCall
// and then read — so the projection is self-healing and the raw Interaction store
// keeps working as the source of truth. A production deployment additionally
// projects on ingest (write-through) and/or via a scheduled sync; this read-path
// backfill guarantees correctness even before that runs.

import { repositories } from '@emgloop/database';
import type { CallGridWindow } from '@emgloop/intelligence';

/**
 * Load one window of aggregated call economics for an organization, from the
 * MarketplaceCall projection. Read-only aside from the idempotent backfill that
 * populates the projection when a window has not been projected yet. Returns a
 * zeroed window when there are genuinely no calls — the module reads that as an
 * honest "Not enough data", never a fabricated $0.
 */
export async function loadCallGridWindow(
  organizationId: string,
  since: Date,
  until: Date,
): Promise<CallGridWindow> {
  const repo = repositories.marketplaceCalls;

  // Self-healing backfill: only when the window is empty, project existing
  // Interactions into MarketplaceCall (idempotent upsert on provider+externalId).
  const projected = await repo.countWindow(organizationId, since, until);
  if (projected === 0) {
    await repo.projectWindow(organizationId, since, until);
  }

  // CallWindowAggregate is structurally the CallGridWindow the module consumes.
  return repo.aggregateWindow(organizationId, since, until);
}
