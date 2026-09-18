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
  composeCallGridBrief,
  selectTopPriorities,
  situationKind,
  whyItMatters,
  voiceOf,
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

export async function loadExecutiveAnalysis(ctx: CommandContext): Promise<ExecutiveAnalysis> {
  const { organizationId: org, window, report, now, desc } = ctx;
  const [bid, history, roster] = await Promise.all([
    loadBidReport(org),
    loadCallGridHistory(org, window),
    repositories.iam.listUsers(org).catch(() => []),
  ]);
  const bidMatches = bidSnapshotMatches(bid.meta, window);
  const intel = callGridIntelligence(report, now, {
    history,
    // Null when the provider did not report them, which makes the risk model
    // WITHHOLD those factors rather than score them safe.
    bidRejectRate: overallRejectRate(bid.sources),
    rateLimitedShare: destinationRateLimitedShare(bid.destinations),
  });
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
  return {
    key: s.key,
    title: s.title,
    kind,
    kindLabel: SITUATION_KIND_LABELS[kind],
    explanation: firstSentence(whyItMatters(s)) ?? firstSentence(voice?.plainLanguageSummary) ?? s.whatHappened,
    action: s.decision,
    href,
  };
}

export function executiveBrief(ctx: CommandContext, analysis: ExecutiveAnalysis): CallGridBrief {
  const overall = analysis.intel.health.overall;
  return composeCallGridBrief({
    window: ctx.window,
    metrics: ctx.report.metrics,
    comparison: ctx.report.comparison,
    buyers: ctx.report.dimensions.buyers.map((r) => ({ label: r.label, revenueCents: r.revenueCents })),
    campaigns: ctx.report.dimensions.campaigns.map((r) => ({ label: r.label, revenueCents: r.revenueCents })),
    // Loop's reading, in one sentence; the full health model is in Intelligence.
    health: { band: overall.band, explanation: firstSentence(overall.explanation) },
  });
}
