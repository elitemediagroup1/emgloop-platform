// CallGrid and Campaigns intelligence (Loop Intelligence Phase E, 2026-09-26). The ORGANIZATION's call
// economics, from Loop's projected calls (marketplace_calls, via MarketplaceCallRepository.aggregateWindow
// -- the same aggregate the command center, the Home tile and the detection pass read). Never a CallGrid
// API call.
//
//   callgrid.domain@1    the last 7 days against the 7 before (COMPARABLE windows of equal length):
//     MEASURED   calls, billable (monetized) calls, reported revenue and margin -- economics carry their
//                coverage, because a total over calls that did not report a value is a lower bound;
//     OBSERVED   a change of 20% or more in calls or revenue; one buyer carrying most of the revenue;
//                no calls in the last day when the week before had them.
//   campaigns.domain@1   the same windows per campaign: the campaigns that grew, shrank, went quiet, or
//                        carry calls that nobody bought.
//
// Coverage: if the organization's call record starts inside the prior window, there is no comparison
// (a start is not a change), and the reading says so.

import type { CallDimensionAggregate, CallWindowAggregate, MarketplaceCallRepository } from '../../../repositories/marketplace-call.repository';
import { AI_TASK_CALLGRID_DOMAIN_READING, AI_TASK_CAMPAIGNS_DOMAIN_READING, type IntelligenceSignal } from '@emgloop/shared';

import type { IntelligenceProducer } from '../producer';
import { domainProducer, type DomainKitPorts, type RuleReading } from '../domain-kit';
import { comparableChange, DAY_MS, fingerprintOf, money, organizationModelStage, organizationTarget, plural, safeRef } from './organization-kit';

const WINDOW_DAYS = 7;
const CHANGE_THRESHOLD = 20;

interface CallsContext {
  readonly current: CallWindowAggregate;
  readonly prior: CallWindowAggregate | null;
  readonly lastDayCalls: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

type CallsPort = Pick<MarketplaceCallRepository, 'aggregateWindow' | 'firstCallAt' | 'organizationIdsWithCallsSince'>;

async function gatherCalls(calls: CallsPort, organizationId: string, now: Date) {
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const priorStart = new Date(windowStart.getTime() - WINDOW_DAYS * DAY_MS);
  const first = await calls.firstCallAt(organizationId);
  if (!first) return null;
  const [current, lastDay] = await Promise.all([calls.aggregateWindow(organizationId, windowStart, windowEnd), calls.aggregateWindow(organizationId, new Date(now.getTime() - DAY_MS), windowEnd)]);
  // The prior window is comparable only when Loop's record covers all of it.
  const prior = first <= priorStart ? await calls.aggregateWindow(organizationId, priorStart, windowStart) : null;
  return { current, prior, lastDayCalls: lastDay.calls, windowStart, windowEnd } satisfies CallsContext;
}

function memberRef(dimension: 'buyer' | 'campaign', key: string): string | null {
  return safeRef(`provider_member:callgrid:${dimension}:${key}`);
}

const WINDOW_REF = 'marketplace_calls:7d';
const PRIOR_REF = 'marketplace_calls:prior-7d';

export function callgridRule(ctx: CallsContext, now: Date): RuleReading {
  const c = ctx.current;
  const asOf = now.toISOString();
  const signals: IntelligenceSignal[] = [];
  const limitations: string[] = [];
  signals.push({ key: 'calls', kind: 'OPERATIONAL', knowledge: 'MEASURED', statement: `${plural(c.calls, 'call')} in the last ${WINDOW_DAYS} days.`, evidenceRefs: [WINDOW_REF], metric: { name: 'calls', value: c.calls, unit: 'count' }, asOf });
  signals.push({ key: 'billable', kind: 'OPERATIONAL', knowledge: 'MEASURED', statement: `${plural(c.monetized, 'billable call')}.`, evidenceRefs: [WINDOW_REF], metric: { name: 'billable_calls', value: c.monetized, unit: 'count' }, asOf });
  if (c.callsWithRevenue > 0) {
    const partial = c.callsWithRevenue < c.calls;
    signals.push({ key: 'revenue', kind: 'OPERATIONAL', knowledge: 'MEASURED', statement: `${money(c.revenueCents)} reported revenue${partial ? ` on ${plural(c.callsWithRevenue, 'call')} that reported it (a lower bound)` : ''}.`, evidenceRefs: [WINDOW_REF], metric: { name: 'revenue', value: c.revenueCents, unit: 'minor_currency' }, asOf, confidence: partial ? 'MEDIUM' : 'HIGH' });
    if (partial) limitations.push('Revenue is reported on only some calls, so revenue is a lower bound.');
    if (c.callsWithPayout === c.calls && !partial) signals.push({ key: 'margin', kind: 'OPERATIONAL', knowledge: 'MEASURED', statement: `${money(c.revenueCents - c.payoutCents)} margin after payouts.`, evidenceRefs: [WINDOW_REF], metric: { name: 'margin', value: c.revenueCents - c.payoutCents, unit: 'minor_currency' }, asOf });
  } else if (c.calls > 0) {
    limitations.push('No call in the window reported revenue, so revenue is unknown, not zero.');
  }
  if (!ctx.prior) {
    limitations.push(`Loop’s call record does not cover the ${WINDOW_DAYS} days before, so there is no comparison yet.`);
  } else {
    const callChange = comparableChange(c.calls, ctx.prior.calls);
    if (callChange !== null && Math.abs(callChange) >= CHANGE_THRESHOLD) {
      signals.push({ key: 'calls-change', kind: callChange < 0 ? 'RISK' : 'CHANGE', knowledge: 'OBSERVED', statement: `Calls are ${callChange < 0 ? 'down' : 'up'} ${Math.abs(callChange)}% on the previous ${WINDOW_DAYS} days (${ctx.prior.calls} to ${c.calls}).`, evidenceRefs: [WINDOW_REF, PRIOR_REF], severity: Math.abs(callChange) >= 40 ? 'HIGH' : 'MEDIUM', asOf });
    }
    const comparableRevenue = c.callsWithRevenue === c.calls && ctx.prior.callsWithRevenue === ctx.prior.calls;
    const revChange = comparableRevenue ? comparableChange(c.revenueCents, ctx.prior.revenueCents, 100) : null;
    if (revChange !== null && Math.abs(revChange) >= CHANGE_THRESHOLD) {
      signals.push({ key: 'revenue-change', kind: revChange < 0 ? 'RISK' : 'OPPORTUNITY', knowledge: 'OBSERVED', statement: `Reported revenue is ${revChange < 0 ? 'down' : 'up'} ${Math.abs(revChange)}% on the previous ${WINDOW_DAYS} days.`, evidenceRefs: [WINDOW_REF, PRIOR_REF], severity: Math.abs(revChange) >= 40 ? 'HIGH' : 'MEDIUM', asOf });
    }
    if (ctx.lastDayCalls === 0 && ctx.prior.calls >= WINDOW_DAYS) {
      signals.push({ key: 'quiet-day', kind: 'QUIET', knowledge: 'OBSERVED', statement: 'No calls have arrived in the last day.', evidenceRefs: ['marketplace_calls:1d', PRIOR_REF], severity: 'HIGH', asOf });
    }
  }
  const topBuyer = [...c.buyers].sort((a, b) => b.revenueCents - a.revenueCents)[0];
  const entityRefs: string[] = [];
  if (topBuyer && c.revenueCents > 0 && c.callsWithRevenue === c.calls) {
    const share = Math.round((topBuyer.revenueCents / c.revenueCents) * 100);
    const ref = memberRef('buyer', topBuyer.key);
    if (share >= 60 && c.buyers.length > 1 && ref) {
      entityRefs.push(ref);
      signals.push({ key: 'buyer-concentration', kind: 'RISK', knowledge: 'OBSERVED', statement: `One buyer carries ${share}% of reported revenue.`, entities: [ref], evidenceRefs: [WINDOW_REF], severity: share >= 80 ? 'HIGH' : 'MEDIUM', asOf });
    }
  }
  const attention = signals.some((s) => s.severity === 'HIGH');
  const watch = signals.some((s) => s.kind === 'RISK' || s.kind === 'QUIET');
  const change = signals.find((s) => s.key === 'calls-change');
  return {
    statement: c.calls === 0 ? `No calls in the last ${WINDOW_DAYS} days.` : `${plural(c.calls, 'call')} in the last ${WINDOW_DAYS} days, ${c.monetized} billable${c.callsWithRevenue > 0 ? `, ${money(c.revenueCents)} reported revenue` : ''}${change ? `; ${change.statement.charAt(0).toLowerCase()}${change.statement.slice(1, -1)}` : ''}.`,
    status: attention ? 'ATTENTION' : watch ? 'WATCH' : 'CALM',
    confidence: ctx.prior ? 'HIGH' : 'MEDIUM',
    signals,
    limitations,
    entityRefs,
    coverage: ctx.prior ? 'CONNECTED_SUFFICIENT' : 'CONNECTED_PARTIAL',
    windowStart: ctx.windowStart,
    windowEnd: ctx.windowEnd,
    evidenceCount: c.calls,
    // The aggregate is read at `now`; the window's calls are evidence as of that read.
    lastEvidenceAt: c.calls > 0 ? now : null,
    sources: [{ sourceId: 'CALLGRID', asOf, coverage: ctx.prior ? 'CONNECTED_SUFFICIENT' : 'CONNECTED_PARTIAL' }],
    sourceRefs: [WINDOW_REF, ...(ctx.prior ? [PRIOR_REF] : [])],
  };
}

function byKey(rows: readonly CallDimensionAggregate[]): Map<string, CallDimensionAggregate> {
  return new Map(rows.map((r) => [r.key, r]));
}

export function campaignsRule(ctx: CallsContext, now: Date): RuleReading {
  const asOf = now.toISOString();
  const current = ctx.current.campaigns;
  const prior = byKey(ctx.prior?.campaigns ?? []);
  const signals: IntelligenceSignal[] = [
    { key: 'active-campaigns', kind: 'OPERATIONAL', knowledge: 'MEASURED', statement: `${plural(current.length, 'campaign')} carried calls in the last ${WINDOW_DAYS} days.`, evidenceRefs: [WINDOW_REF], metric: { name: 'active_campaigns', value: current.length, unit: 'count' }, asOf },
  ];
  const entityRefs: string[] = [];
  const moves: { ref: string; change: number; row: CallDimensionAggregate; before: number }[] = [];
  if (ctx.prior) {
    for (const row of current) {
      const before = prior.get(row.key)?.calls ?? 0;
      const change = comparableChange(row.calls, before);
      const ref = memberRef('campaign', row.key);
      if (ref && change !== null && Math.abs(change) >= CHANGE_THRESHOLD) moves.push({ ref, change, row, before });
    }
    for (const [key, row] of prior) {
      const ref = memberRef('campaign', key);
      if (ref && row.calls >= 5 && !current.some((c) => c.key === key)) moves.push({ ref, change: -100, row, before: row.calls });
    }
  }
  moves.sort((a, b) => Math.abs(b.change) * b.before - Math.abs(a.change) * a.before);
  for (const m of moves.slice(0, 6)) {
    entityRefs.push(m.ref);
    signals.push({
      key: `campaign.${m.ref.slice(-40)}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64),
      kind: m.change === -100 ? 'QUIET' : m.change < 0 ? 'RISK' : 'CHANGE',
      knowledge: 'OBSERVED',
      statement: m.change === -100 ? `A campaign that carried ${m.before} calls the week before carried none this week.` : `A campaign’s calls are ${m.change < 0 ? 'down' : 'up'} ${Math.abs(m.change)}% (${m.before} to ${m.row.calls}).`,
      entities: [m.ref],
      evidenceRefs: [WINDOW_REF, PRIOR_REF],
      severity: Math.abs(m.change) >= 50 ? 'HIGH' : 'MEDIUM',
      asOf,
    });
  }
  const unsold = current.filter((r) => r.calls >= 10 && r.monetized === 0).slice(0, 3);
  for (const r of unsold) {
    const ref = memberRef('campaign', r.key);
    if (!ref) continue;
    entityRefs.push(ref);
    signals.push({ key: `unsold.${r.key}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64), kind: 'RISK', knowledge: 'OBSERVED', statement: `A campaign carried ${r.calls} calls and none were billable.`, entities: [ref], evidenceRefs: [WINDOW_REF], severity: 'HIGH', asOf });
  }
  const high = signals.filter((s) => s.severity === 'HIGH').length;
  return {
    statement: current.length === 0 ? `No campaign carried calls in the last ${WINDOW_DAYS} days.` : `${plural(current.length, 'campaign')} active${moves.length ? `; ${plural(Math.min(moves.length, 6), 'campaign')} moved sharply against the week before` : ''}${unsold.length ? `; ${plural(unsold.length, 'campaign')} with no billable calls` : ''}.`,
    status: high > 0 ? 'ATTENTION' : moves.length > 0 ? 'WATCH' : 'CALM',
    confidence: ctx.prior ? 'HIGH' : 'MEDIUM',
    signals: signals.slice(0, 12),
    limitations: ctx.prior ? [] : [`Loop’s call record does not cover the ${WINDOW_DAYS} days before, so campaign movement cannot be read yet.`],
    entityRefs,
    coverage: ctx.prior ? 'CONNECTED_SUFFICIENT' : 'CONNECTED_PARTIAL',
    windowStart: ctx.windowStart,
    windowEnd: ctx.windowEnd,
    evidenceCount: ctx.current.calls,
    lastEvidenceAt: ctx.current.calls > 0 ? now : null,
    sources: [{ sourceId: 'CALLGRID', asOf, coverage: ctx.prior ? 'CONNECTED_SUFFICIENT' : 'CONNECTED_PARTIAL' }],
    sourceRefs: [WINDOW_REF, ...(ctx.prior ? [PRIOR_REF] : [])],
  };
}

function callsFingerprint(domain: string, ctx: CallsContext, dayKey: string): string {
  const slim = (a: CallWindowAggregate | null) => a && [a.calls, a.monetized, a.revenueCents, a.payoutCents, a.callsWithRevenue, a.campaigns.map((r) => [r.key, r.calls, r.monetized]).sort(), a.buyers.map((r) => [r.key, r.revenueCents]).sort()];
  return fingerprintOf(domain, [dayKey, slim(ctx.current), slim(ctx.prior), ctx.lastDayCalls]);
}

function callsSpec(calls: CallsPort, domain: 'CALLGRID' | 'CAMPAIGNS') {
  return {
    domain,
    scope: 'ORGANIZATION' as const,
    version: '1',
    provider: null,
    consentBasis: 'LOOP_RECORDS' as const,
    async discover(now: Date) {
      const orgs = await calls.organizationIdsWithCallsSince(new Date(now.getTime() - 2 * WINDOW_DAYS * DAY_MS), 50);
      return orgs.map((id) => organizationTarget(id, domain));
    },
    async gather(target: Parameters<IntelligenceProducer['gather']>[0], now: Date) {
      if (target.scope !== 'ORGANIZATION') return { status: 'NOT_PERMITTED', reason: 'ORGANIZATION_ONLY' } as const;
      const ctx = await gatherCalls(calls, target.organizationId, now);
      if (!ctx) return { status: 'NO_EVIDENCE' } as const;
      // An hour bucket: the same calls re-read within the hour are the same reading.
      return { status: 'READY', context: ctx, fingerprint: callsFingerprint(domain, ctx, now.toISOString().slice(0, 13)) } as const;
    },
  };
}

export function callgridDomainProducer(calls: CallsPort, kit: DomainKitPorts): IntelligenceProducer<CallsContext> {
  return domainProducer<CallsContext>(
    {
      id: 'callgrid.domain@1',
      ...callsSpec(calls, 'CALLGRID'),
      rule: callgridRule,
      model: organizationModelStage(AI_TASK_CALLGRID_DOMAIN_READING, {
        domainDescription: "the organization's call marketplace economics over the last seven days against the seven before",
        audience: 'ORGANIZATION',
        lookFor: ['what moved and whether it matters', 'where revenue depends on too little', 'what is quiet that should not be', 'what an operator should look at first'],
      }),
    },
    kit,
  );
}

export function campaignsDomainProducer(calls: CallsPort, kit: DomainKitPorts): IntelligenceProducer<CallsContext> {
  return domainProducer<CallsContext>(
    {
      id: 'campaigns.domain@1',
      ...callsSpec(calls, 'CAMPAIGNS'),
      rule: campaignsRule,
      model: organizationModelStage(AI_TASK_CAMPAIGNS_DOMAIN_READING, {
        domainDescription: "the organization's call campaigns over the last seven days against the seven before",
        audience: 'ORGANIZATION',
        lookFor: ['campaigns that grew or shrank sharply', 'campaigns that went quiet', 'campaigns carrying calls nobody buys'],
      }),
    },
    kit,
  );
}
