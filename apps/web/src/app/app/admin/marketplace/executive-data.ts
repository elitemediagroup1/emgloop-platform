import 'server-only';

// The analysis behind the executive layer and the Intelligence workspace -- the
// SAME engine run, the same operational record, the same order as before. Nothing
// here ranks, scores or re-words a finding: it gathers what the engine and the
// decision record already hold, and cuts the priorities to the few that are
// undecided.
//
// Detection is recorded here, exactly as the Overview always did (idempotent per
// analysis period -- see `callGridDetectionKey`), and only on the two surfaces that
// show the queue: the Overview and Intelligence.

import {
  callGridHealthReason,
  composeCallGridBrief,
  selectTopPriorities,
  situationKind,
  whyItMatters,
  voiceOf,
  healthSignalReason,
  weakestHealthSignal,
  SITUATION_KIND_LABELS,
  type CallGridBrief,
  type CallGridIntelligence,
  type SituationKind,
  type Situation,
} from '@emgloop/shared';
import { repositories } from '@emgloop/database';

import { loadBidReport, bidSnapshotMatches, overallRejectRate, destinationRateLimitedShare, type BidReport } from './bid-report';
import { loadCallGridHistory } from './callgrid-history-data';
import { callGridIntelligence, bidIntelligence, type BidIntelligenceResult } from './intelligence-data';
import { loadOperationalQueue, type LivePriority, type OperationalQueue } from './operational-queue-data';
import type { QueueMember } from './queue-ui';
import type { CommandContext } from './command-data';
import { withQuery } from './command-data';

export interface ExecutiveAnalysis {
  readonly intel: CallGridIntelligence;
  readonly ops: OperationalQueue;
  readonly bid: BidReport;
  readonly bidMatches: boolean;
  readonly bidIntel: BidIntelligenceResult;
  readonly members: QueueMember[];
}

/**
 * The engine's READING of the period -- health, findings -- from reads only. Nothing is recorded:
 * the operational queue (which records what the engine detected) is not touched. Loop Home's CallGrid
 * tile uses this, so rendering Home never writes; the Overview builds on it and then records.
 */
export async function loadExecutiveReading(ctx: CommandContext): Promise<{ readonly intel: ExecutiveAnalysis['intel']; readonly bid: BidReport }> {
  const { organizationId: org, window, report, now } = ctx;
  const [bid, history] = await Promise.all([loadBidReport(org), loadCallGridHistory(org, window, ctx.coverage)]);
  const intel = callGridIntelligence(report, now, {
    history,
    // Null when the provider did not report them, which makes the risk model
    // WITHHOLD those factors rather than score them safe.
    bidRejectRate: overallRejectRate(bid.sources),
    rateLimitedShare: destinationRateLimitedShare(bid.destinations),
  });
  return { intel, bid };
}

export async function loadExecutiveAnalysis(ctx: CommandContext): Promise<ExecutiveAnalysis> {
  const { organizationId: org, window, now, desc } = ctx;
  const [{ intel, bid }, roster] = await Promise.all([loadExecutiveReading(ctx), repositories.iam.listUsers(org).catch(() => [])]);
  const bidMatches = bidSnapshotMatches(bid.meta, window);
  const ops = await loadOperationalQueue(org, intel.queue, { window, now });
  const members: QueueMember[] = roster
    .filter((m) => m.status === 'ACTIVE')
    .map((m) => ({ id: m.id, name: m.name, email: m.email }));
  return { intel, ops, bid, bidMatches, bidIntel: bidIntelligence(bid, now, desc.periodTitle, bidMatches), members };
}

/** Where a decision opens: its own page when it has a durable record, else its card in the queue. */
export function situationHref(ctx: CommandContext, item: LivePriority): string {
  return item.record
    ? withQuery(`/app/admin/marketplace/intelligence/${encodeURIComponent(item.record.id)}`, ctx.query)
    : withQuery('/app/admin/marketplace/intelligence', ctx.query) + `#decision-${item.situation.id}`;
}

const ENTITY_ROUTE: Readonly<Record<string, string>> = {
  buyer: 'buyers', vendor: 'vendors', source: 'sources', campaign: 'campaigns',
};

/**
 * Where a Situation's numbers live: the entity page it is about (with the entity's
 * key, as the list rows key it), the Bids workspace for a bid finding, Money for the
 * marketplace as a whole. Derived from the entity the lead finding names -- nothing
 * is invented when there is none.
 */
export function numbersHref(ctx: CommandContext, s: Situation): string {
  const entity = (voiceOf(s) ?? s.observations[0])?.affectedEntities[0];
  const base = '/app/admin/marketplace';
  if (entity && ENTITY_ROUTE[entity.entityType]) {
    const key = (entity.entityId || entity.entityName).toLowerCase();
    return withQuery(`${base}/${ENTITY_ROUTE[entity.entityType]}/${encodeURIComponent(key)}`, ctx.query);
  }
  if (entity && (entity.entityType === 'bid_source' || entity.entityType === 'bid_destination')) return withQuery(`${base}/bids`, ctx.query);
  return withQuery(`${base}/money`, ctx.query);
}

/** The first sentence of a text, for a one-line surface. The whole text stays on the situation page. */
export function firstSentence(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const m = /^.+?[.!?](?=\s|$)/.exec(t);
  return (m ? m[0] : t).trim();
}

export interface TopPriority {
  readonly key: string;
  readonly title: string;
  readonly kind: SituationKind;
  readonly kindLabel: string;
  /** One line: why it matters, in the engine's own words. */
  readonly explanation: string;
  /** The suggested next action, in review language. */
  readonly action: string | null;
  readonly href: string;
  /** The metric the voice finding measures, and which way it moved -- so the brief can point at it by name. */
  readonly metric: string | null;
  readonly direction: 'up' | 'down' | null;
}

/** At most three undecided Situations, in the engine's order. */
export function topPriorities(ctx: CommandContext, analysis: ExecutiveAnalysis): TopPriority[] {
  return selectTopPriorities(analysis.ops.items, (i) => i.state === 'NEEDS_REVIEW').map((item) => priorityOf(item.situation, situationHref(ctx, item)));
}

/**
 * One priority, from ONE finding: the Situation's voice. The headline is its title, the
 * explanation its measured consequence (or its own plain-language summary), and the
 * action its own review -- or none, which is said as none rather than borrowed from
 * another finding merged into the same Situation.
 */
export function priorityOf(s: Situation, href: string): TopPriority {
  const voice = voiceOf(s);
  const kind = situationKind(s);
  const moved = voice ? voice.percentageChange ?? voice.absoluteChange : null;
  return {
    key: s.key,
    title: s.title,
    kind,
    kindLabel: SITUATION_KIND_LABELS[kind],
    explanation: firstSentence(whyItMatters(s)) ?? firstSentence(voice?.plainLanguageSummary) ?? s.whatHappened,
    action: s.decision,
    href,
    metric: voice?.primaryMetric ?? null,
    direction: moved === null || moved === 0 ? null : moved > 0 ? 'up' : 'down',
  };
}

/**
 * The brief for this period. The band is the health model's; its reason and the
 * change sentence count movements only against a comparison Loop's record covers
 * (the report's comparison is null otherwise), and the attention sentence points at
 * the first of the priorities shown beneath it -- the same list, never a second ranking.
 */
export function executiveBrief(ctx: CommandContext, analysis: Pick<ExecutiveAnalysis, 'intel'>, first: TopPriority | null): CallGridBrief {
  const health = analysis.intel.health;
  const overall = health.overall;
  const comparison = ctx.report.comparison;
  const weakest = weakestHealthSignal(health);
  return composeCallGridBrief({
    window: ctx.window,
    metrics: ctx.report.metrics,
    comparison,
    coverage: ctx.coverage,
    buyers: ctx.report.dimensions.buyers.map((r) => ({ label: r.label, revenueCents: r.revenueCents })),
    campaigns: ctx.report.dimensions.campaigns.map((r) => ({ label: r.label, revenueCents: r.revenueCents })),
    health: {
      band: overall.band,
      reason: callGridHealthReason({
        band: overall.band,
        weakest: weakest ? { id: weakest.id, reason: healthSignalReason(weakest) } : null,
        metrics: ctx.report.metrics,
        comparison,
      }),
      explanation: overall.explanation,
      determinacy: overall.determinacy,
    },
    firstPriority: first ? { title: first.title, metric: first.metric, direction: first.direction } : null,
  });
}
