// Website evidence retention (WEBSITE_EVIDENCE_RETENTION, @emgloop/shared website-evidence.ts).
//
// THE WINDOWS ARE THE POLICY'S; this step carries no number of its own.
//   WEBSITE_SOURCE_AGGREGATES  ACTIVE: source_metric_windows that ended before the window are deleted.
//   WEBSITE_RAW_TELEMETRY      DISABLED_UNTIL_ENABLED: runs only when LOOP_WEBSITE_TELEMETRY_RETENTION is 'on'.
//                              Off (unset, anything else) purges nothing. The purge can never select a WEB_LEAD's
//                              form submission (it deletes only interactions with no Person), but enabling it
//                              truncates website analytics history, so it waits for an explicit decision.
//
// Counts only are logged; a failure is reported by name and never thrown -- the sweep's other steps must run.

import { WEBSITE_EVIDENCE_RETENTION } from '@emgloop/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WebsiteRetentionPorts {
  /** Whether LOOP_WEBSITE_TELEMETRY_RETENTION enabled the raw telemetry purge. */
  readonly telemetryEnabled: boolean;
  readonly purgeTelemetry: (cutoff: Date) => Promise<{ readonly interactions: number; readonly integrationEvents: number }>;
  readonly purgeAggregates: (cutoff: Date) => Promise<{ readonly purged: number }>;
  readonly now: () => Date;
  readonly log: (event: string, fields?: Record<string, unknown>) => void;
}

function cutoffFor(category: string, now: Date): Date | null {
  const policy = WEBSITE_EVIDENCE_RETENTION.find((p) => p.category === category);
  if (!policy || !Number.isFinite(policy.days) || policy.days <= 0) return null;
  return new Date(now.getTime() - policy.days * DAY_MS);
}

export async function runWebsiteRetention(ports: WebsiteRetentionPorts): Promise<{ aggregates: number | null; telemetry: { interactions: number; integrationEvents: number } | null }> {
  const now = ports.now();
  let aggregates: number | null = null;
  const aggregateCutoff = cutoffFor('WEBSITE_SOURCE_AGGREGATES', now);
  if (aggregateCutoff) {
    try {
      aggregates = (await ports.purgeAggregates(aggregateCutoff)).purged;
      if (aggregates > 0) ports.log('website_aggregate_purge', { purged: aggregates });
    } catch (err) {
      ports.log('website_aggregate_purge_error', { name: (err as Error)?.name ?? 'error' });
    }
  }
  let telemetry: { interactions: number; integrationEvents: number } | null = null;
  const telemetryCutoff = cutoffFor('WEBSITE_RAW_TELEMETRY', now);
  if (ports.telemetryEnabled && telemetryCutoff) {
    try {
      telemetry = await ports.purgeTelemetry(telemetryCutoff);
      if (telemetry.interactions + telemetry.integrationEvents > 0) ports.log('website_telemetry_purge', { ...telemetry });
    } catch (err) {
      ports.log('website_telemetry_purge_error', { name: (err as Error)?.name ?? 'error' });
    }
  }
  return { aggregates, telemetry };
}
