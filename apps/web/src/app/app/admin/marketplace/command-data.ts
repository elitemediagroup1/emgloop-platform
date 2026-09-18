import 'server-only';

// The command center's shared read — what EVERY CallGrid section needs before its
// own workspace: who is asking, which period, the canonical report for it, the
// series behind the KPI sparklines and the trend chart, and how current the data
// really is.
//
// ONE READ PATH. Every KPI is the canonical report's own figure
// (`loadCallGridReport`), so the KPI row and a section's table cannot disagree.
// The series comes from `windowFacts`, which reads the same rows under the same
// filter and is tested to sum to the same totals.
//
// FRESHNESS FROM FACTS. "Live" is decided by when CallGrid last DELIVERED data --
// the connection's last sync, the newest integration event, the poll checkpoint --
// never by the clock this page was rendered at.
//
// THE ORGANIZATION COMES FROM THE SIGNED SESSION. The URL carries a period and,
// on a detail page, an entity key; neither is authority.

import {
  assessCallGridFreshness,
  callGridBuckets,
  callGridKpis,
  describeCallGridWindow,
  readCallGridSelection,
  type CallGridBuckets,
  type CallGridFreshness,
  type CallGridKpi,
  type CallGridSelection,
  type CallGridWindow,
  type CallGridWindowDescription,
} from '@emgloop/shared';
import { repositories, type CallWindowFacts, type CallEntitySelector } from '@emgloop/database';

import type { AuthSession } from '../../../../auth/auth';
import { hasPermission } from '../../../../auth/guard';
import { loadOrFallback } from '../../../../demo/db-health';
import { loadCallGridReport, type CallGridReport } from './callgrid-report';

export type SearchParams = Readonly<Record<string, string | string[] | undefined>> | undefined;

const PROVIDER = 'callgrid';

export interface CommandContext {
  readonly session: AuthSession;
  readonly organizationId: string;
  readonly now: Date;
  readonly selection: CallGridSelection;
  readonly window: CallGridWindow;
  readonly desc: CallGridWindowDescription;
  readonly report: CallGridReport;
  readonly buckets: CallGridBuckets;
  /** The selected period's calls, bucketed. Null when the read failed. */
  readonly facts: CallWindowFacts | null;
  /** The comparison period's calls, bucketed. Null when there is none or the read failed. */
  readonly comparisonFacts: CallWindowFacts | null;
  readonly kpis: CallGridKpi[];
  readonly freshness: CallGridFreshness;
  /** The selection's query, to carry on every CallGrid link. */
  readonly query: string;
  /** May this person act on decisions (Review/Assign/Watch/Resolve/Dismiss)? */
  readonly canAct: boolean;
}

/**
 * Everything the executive layer of any CallGrid section needs. The caller is a page
 * that has ALREADY enforced its authority -- `requireWorkspacePermission('ADMIN',
 * 'intelligence', 'view')`, as its first await -- and hands over the session that
 * returned; the organization is that session's and nobody else's.
 */
export async function loadCommandContext(session: AuthSession, searchParams: SearchParams): Promise<CommandContext> {
  const organizationId = session.organizationId;
  const now = new Date();
  const selection = readCallGridSelection(searchParams, now);
  const window = selection.window;
  const buckets = callGridBuckets(window);

  const [report, factsR, comparisonR, freshnessFacts, canAct] = await Promise.all([
    loadCallGridReport(organizationId, window),
    loadOrFallback(() => repositories.marketplaceCalls.windowFacts(organizationId, window.start, window.end, { buckets: buckets.current })),
    window.comparisonStart && window.comparisonEnd
      ? loadOrFallback(() =>
          repositories.marketplaceCalls.windowFacts(organizationId, window.comparisonStart!, window.comparisonEnd!, { buckets: buckets.comparison }),
        )
      : Promise.resolve(null),
    loadFreshnessFacts(organizationId),
    hasPermission('intelligence', 'update'),
  ]);

  const facts = factsR.ok ? factsR.data : null;
  const comparisonFacts = comparisonR && comparisonR.ok ? comparisonR.data : null;

  const kpis = callGridKpis({
    metrics: report.metrics,
    comparison: report.comparison,
    series: facts?.series ?? [],
  });
  const freshness = assessCallGridFreshness({
    now,
    readOk: report.ok,
    periodLive: window.includesLiveData,
    ...freshnessFacts,
  });

  return {
    session,
    organizationId,
    now,
    selection,
    window,
    desc: describeCallGridWindow(window, now),
    report,
    buckets,
    facts,
    comparisonFacts,
    kpis,
    freshness,
    query: selection.query,
    canAct,
  };
}

/** When CallGrid last delivered anything, and whether recent deliveries failed. Never throws. */
async function loadFreshnessFacts(organizationId: string): Promise<{
  lastDeliveryAt: Date | null;
  pollCompletedThrough: Date | null;
  recentDeliveries: { status: string; receivedAt: Date }[];
  factsOk: boolean;
}> {
  try {
    const [connections, events, checkpoint] = await Promise.all([
      repositories.integrations.listConnections(organizationId),
      repositories.integrations.listRecentEvents(organizationId, { provider: PROVIDER, limit: 50 }),
      repositories.pollCheckpoints.find(organizationId, PROVIDER, 'calls'),
    ]);
    const synced = connections
      .filter((c) => c.provider === PROVIDER && c.lastSyncedAt)
      .map((c) => new Date(c.lastSyncedAt!));
    const received = events.map((e) => ({ status: e.status, receivedAt: new Date(e.receivedAt) }));
    const candidates = [...synced, ...(received[0] ? [received[0].receivedAt] : [])];
    const lastDeliveryAt = candidates.length > 0 ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
    return {
      lastDeliveryAt,
      pollCompletedThrough: checkpoint?.completedThrough ?? null,
      recentDeliveries: received,
      factsOk: true,
    };
  } catch {
    return { lastDeliveryAt: null, pollCompletedThrough: null, recentDeliveries: [], factsOk: false };
  }
}

/** One entity's calls for the selected and comparison periods, bucketed like the KPIs. */
export async function loadEntityFacts(
  ctx: CommandContext,
  entity: CallEntitySelector,
): Promise<{ current: CallWindowFacts | null; comparison: CallWindowFacts | null }> {
  const { organizationId, window, buckets } = ctx;
  const [cur, cmp] = await Promise.all([
    loadOrFallback(() => repositories.marketplaceCalls.windowFacts(organizationId, window.start, window.end, { buckets: buckets.current, entity })),
    window.comparisonStart && window.comparisonEnd
      ? loadOrFallback(() =>
          repositories.marketplaceCalls.windowFacts(organizationId, window.comparisonStart!, window.comparisonEnd!, { buckets: buckets.comparison, entity }),
        )
      : Promise.resolve(null),
  ]);
  return { current: cur.ok ? cur.data : null, comparison: cmp && cmp.ok ? cmp.data : null };
}

/** A CallGrid path with the selection carried on it. */
export function withQuery(path: string, query: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams(query);
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
