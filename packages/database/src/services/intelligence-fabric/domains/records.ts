// Intake, People, Creators, Work and Website intelligence (Loop Intelligence Phase E, 2026-09-26). The
// organization's OWN records, read through their repositories (DomainFactsRepository and each domain's
// own) -- the same records the pages show. Counts, windows and canonical references; no names, no text.
//
//   pipeline.domain@1   Intake: records by status; new records this week against last; records stuck in a
//                       working status with no activity for 14 days.
//   crm.domain@1        People: established people and companies; records awaiting a decision; newly
//                       established this week against last; relationships started and ended.
//   creators.domain@1   Creator Hub: productions waiting on EMG, waiting on a creator, deliverables due.
//   work.domain@1       the organization's work: open, unassigned, overdue, past its committed return,
//                       completed this week against last.   (ORGANIZATION)
//   work.mine@1         a person's own assigned work, the same facts for them.   (PRINCIPAL)
//   website.domain@1    website activity from every connected website evidence source (WEBSITE_READERS):
//                       sessions, form submissions, appointment requests, this week against last.
//
// WEBSITE IS SOURCE-READY, NOT SOURCE-FAKED. Today exactly one website source exists: Loop's own website
// events (WEBSITE_EVENTS). An analytics, search, ads or session-replay source joins by adding a
// `WebsiteEvidenceReader` (and its registry entry) -- the reading merges whatever facts the connected
// readers return, and says which sources it read. None is implied before it is connected.

import { AI_TASK_CREATORS_DOMAIN_READING, AI_TASK_CRM_DOMAIN_READING, AI_TASK_PIPELINE_DOMAIN_READING, AI_TASK_WEBSITE_DOMAIN_READING, AI_TASK_WORK_DOMAIN_READING, type IntelligenceSignal } from '@emgloop/shared';

import type { CrmRepository, PipelineStatus } from '../../../repositories/crm.repository';
import type { DomainFactsRepository, WorkFacts } from '../../../repositories/intelligence/domain-facts.repository';
import type { WebsiteAnalyticsRepository } from '../../../repositories/website-analytics.repository';
import type { IntelligenceProducer } from '../producer';
import { domainProducer, type DomainKitPorts, type RuleReading } from '../domain-kit';
import { comparableChange, DAY_MS, fingerprintOf, organizationModelStage, organizationTarget, plural, safeRef } from './organization-kit';

const WEEK = 7 * DAY_MS;
const STALE_DAYS = 14;
const WORKING: readonly PipelineStatus[] = ['New', 'Contacted', 'Quoted'];

function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

function reading(input: {
  statement: string;
  signals: IntelligenceSignal[];
  limitations?: string[];
  entityRefs?: string[];
  sourceId: string;
  sourceRefs: string[];
  evidenceCount: number;
  now: Date;
  windowStart: Date;
}): RuleReading {
  const high = input.signals.some((s) => s.severity === 'HIGH');
  const medium = input.signals.some((s) => s.severity === 'MEDIUM' && s.knowledge !== 'MEASURED');
  return {
    statement: input.statement,
    status: high ? 'ATTENTION' : medium ? 'WATCH' : 'CALM',
    confidence: 'HIGH',
    signals: input.signals.slice(0, 12),
    limitations: input.limitations ?? [],
    entityRefs: input.entityRefs ?? [],
    coverage: 'CONNECTED_SUFFICIENT',
    windowStart: input.windowStart,
    windowEnd: input.now,
    evidenceCount: input.evidenceCount,
    // Counts over Loop's current records are evidence as of the read itself.
    lastEvidenceAt: input.evidenceCount > 0 ? input.now : null,
    sources: [{ sourceId: input.sourceId, asOf: input.now.toISOString(), coverage: 'CONNECTED_SUFFICIENT' }],
    sourceRefs: input.sourceRefs,
  };
}

function measured(key: string, statement: string, ref: string, name: string, value: number, now: Date): IntelligenceSignal {
  return { key, kind: 'OPERATIONAL', knowledge: 'MEASURED', statement, evidenceRefs: [ref], metric: { name, value, unit: 'count' }, asOf: now.toISOString() };
}

function weekChange(key: string, noun: string, current: number, prior: number, ref: string, now: Date, riskWhenDown = true): IntelligenceSignal | null {
  const change = comparableChange(current, prior);
  if (change === null || Math.abs(change) < 25) return null;
  return { key, kind: change < 0 && riskWhenDown ? 'RISK' : 'CHANGE', knowledge: 'OBSERVED', statement: `${noun} ${change < 0 ? 'down' : 'up'} ${Math.abs(change)}% on the week before (${prior} to ${current}).`, evidenceRefs: [ref], severity: Math.abs(change) >= 50 ? 'HIGH' : 'MEDIUM', asOf: now.toISOString() };
}

// --- Intake --------------------------------------------------------------------------------------

interface PipelineContext {
  readonly counts: Record<PipelineStatus, number>;
  readonly week: { newCustomers: number; conversations: number; conversationsAssigned: number };
  readonly prior: { newCustomers: number };
  readonly stale: Record<string, number>;
}

export function pipelineRule(ctx: PipelineContext, now: Date): RuleReading {
  const ref = 'customers:status';
  const working = WORKING.reduce((n, s) => n + (ctx.counts[s] ?? 0), 0);
  const staleTotal = Object.values(ctx.stale).reduce((a, b) => a + b, 0);
  const signals: IntelligenceSignal[] = [
    measured('working', `${plural(working, 'record')} in a working status (New, Contacted or Quoted).`, ref, 'working_records', working, now),
    measured('new-week', `${plural(ctx.week.newCustomers, 'record')} added this week.`, 'customers:7d', 'new_records', ctx.week.newCustomers, now),
    measured('booked', `${plural(ctx.counts.Booked ?? 0, 'record')} booked.`, ref, 'booked_records', ctx.counts.Booked ?? 0, now),
  ];
  const change = weekChange('new-change', 'New records are', ctx.week.newCustomers, ctx.prior.newCustomers, 'customers:7d', now);
  if (change) signals.push(change);
  for (const status of WORKING) {
    const n = ctx.stale[status] ?? 0;
    if (n > 0) signals.push({ key: `stale.${status.toLowerCase()}`, kind: 'STALLED', knowledge: 'OBSERVED', statement: `${plural(n, 'record')} in ${status} with no activity for ${STALE_DAYS} days.`, evidenceRefs: [`customers:stale:${status.toLowerCase()}`], severity: status === 'Quoted' || n >= 10 ? 'HIGH' : 'MEDIUM', asOf: now.toISOString() });
  }
  const unassigned = ctx.week.conversations - ctx.week.conversationsAssigned;
  if (ctx.week.conversations > 0 && unassigned > 0) signals.push({ key: 'unassigned-conversations', kind: 'ATTENTION', knowledge: 'OBSERVED', statement: `${plural(unassigned, 'conversation')} opened this week with no one assigned.`, evidenceRefs: ['conversations:7d'], severity: unassigned >= 5 ? 'HIGH' : 'MEDIUM', asOf: now.toISOString() });
  return reading({
    statement: `${plural(working, 'record')} in progress, ${ctx.week.newCustomers} new this week${staleTotal ? `; ${staleTotal} with no activity for ${STALE_DAYS} days` : ''}.`,
    signals,
    sourceId: 'LOOP_INTAKE',
    sourceRefs: [ref, 'customers:7d', 'conversations:7d', ...WORKING.map((s) => `customers:stale:${s.toLowerCase()}`)],
    evidenceCount: working + (ctx.counts.Booked ?? 0),
    now,
    windowStart: new Date(now.getTime() - WEEK),
  });
}

export function pipelineDomainProducer(crm: Pick<CrmRepository, 'statusCounts' | 'windowCounts'>, facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<PipelineContext> {
  return domainProducer<PipelineContext>(
    {
      id: 'pipeline.domain@1',
      domain: 'PIPELINE',
      scope: 'ORGANIZATION',
      version: '1',
      provider: null,
      consentBasis: 'LOOP_RECORDS',
      discover: async () => (await facts.organizationsWithCustomers()).map((id) => organizationTarget(id, 'PIPELINE')),
      async gather(target, now) {
        if (target.scope !== 'ORGANIZATION') return { status: 'NOT_PERMITTED', reason: 'ORGANIZATION_ONLY' };
        const org = target.organizationId;
        const since = new Date(now.getTime() - WEEK);
        const [counts, week, prior, stale] = await Promise.all([
          crm.statusCounts(org),
          crm.windowCounts(org, since, now),
          crm.windowCounts(org, new Date(since.getTime() - WEEK), since),
          facts.staleByStatus(org, WORKING, new Date(now.getTime() - STALE_DAYS * DAY_MS)),
        ]);
        if (Object.values(counts).every((n) => n === 0)) return { status: 'NO_EVIDENCE' };
        const context = { counts, week, prior: { newCustomers: prior.newCustomers }, stale };
        return { status: 'READY', context, fingerprint: fingerprintOf('PIPELINE', [now.toISOString().slice(0, 10), context]) };
      },
      rule: pipelineRule,
      model: organizationModelStage(AI_TASK_PIPELINE_DOMAIN_READING, { domainDescription: "the organization's intake records and their statuses", audience: 'ORGANIZATION', lookFor: ['records that are stuck', 'whether new demand is rising or falling', 'conversations nobody owns'] }),
    },
    kit,
  );
}

// --- People (CRM) --------------------------------------------------------------------------------

type CrmContext = Awaited<ReturnType<DomainFactsRepository['crmFacts']>>;

export function crmRule(ctx: CrmContext, now: Date): RuleReading {
  const signals: IntelligenceSignal[] = [
    measured('people', `${plural(ctx.people, 'established person', 'established people')}.`, 'parties:established', 'established_people', ctx.people, now),
    measured('companies', `${plural(ctx.companies, 'established company', 'established companies')}.`, 'parties:established', 'established_companies', ctx.companies, now),
    measured('relationships', `${plural(ctx.active, 'active relationship')}.`, 'relationships:active', 'active_relationships', ctx.active, now),
  ];
  if (ctx.awaiting > 0) signals.push({ key: 'awaiting', kind: 'DECISION_PENDING', knowledge: 'OBSERVED', statement: `${plural(ctx.awaiting, 'record')} awaiting an identity decision.`, evidenceRefs: ['parties:unestablished'], severity: ctx.awaiting >= 25 ? 'MEDIUM' : 'LOW', asOf: now.toISOString() });
  const change = weekChange('established-change', 'Newly established records are', ctx.newEstablished, ctx.priorEstablished, 'parties:7d', now, false);
  if (change) signals.push({ ...change, severity: 'LOW' });
  if (ctx.ended > 0) signals.push({ key: 'ended', kind: 'CHANGE', knowledge: 'OBSERVED', statement: `${plural(ctx.ended, 'relationship')} ended this week.`, evidenceRefs: ['relationship_events:7d'], severity: ctx.ended >= 3 ? 'MEDIUM' : 'LOW', asOf: now.toISOString() });
  if (ctx.started > 0) signals.push({ key: 'started', kind: 'CHANGE', knowledge: 'OBSERVED', statement: `${plural(ctx.started, 'relationship')} started this week.`, evidenceRefs: ['relationship_events:7d'], severity: 'LOW', asOf: now.toISOString() });
  return reading({
    statement: `${plural(ctx.people, 'established person', 'established people')} and ${plural(ctx.companies, 'company', 'companies')}, ${ctx.active} active relationships${ctx.awaiting ? `; ${ctx.awaiting} awaiting a decision` : ''}.`,
    signals,
    sourceId: 'LOOP_CRM',
    sourceRefs: ['parties:established', 'parties:unestablished', 'parties:7d', 'relationships:active', 'relationship_events:7d'],
    evidenceCount: ctx.people + ctx.companies,
    now,
    windowStart: new Date(now.getTime() - WEEK),
  });
}

export function crmDomainProducer(facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<CrmContext> {
  return domainProducer<CrmContext>(
    {
      id: 'crm.domain@1',
      domain: 'CRM',
      scope: 'ORGANIZATION',
      version: '1',
      provider: null,
      consentBasis: 'LOOP_RECORDS',
      discover: async () => (await facts.organizationsWithParties()).map((id) => organizationTarget(id, 'CRM')),
      async gather(target, now) {
        if (target.scope !== 'ORGANIZATION') return { status: 'NOT_PERMITTED', reason: 'ORGANIZATION_ONLY' };
        const since = new Date(now.getTime() - WEEK);
        const ctx = await facts.crmFacts(target.organizationId, since, new Date(since.getTime() - WEEK), now);
        if (ctx.people + ctx.companies + ctx.awaiting === 0) return { status: 'NO_EVIDENCE' };
        return { status: 'READY', context: ctx, fingerprint: fingerprintOf('CRM', [now.toISOString().slice(0, 10), ctx]) };
      },
      rule: crmRule,
      model: organizationModelStage(AI_TASK_CRM_DOMAIN_READING, { domainDescription: "the organization's people, companies and relationships (counts only)", audience: 'ORGANIZATION', lookFor: ['relationships ending or starting', 'identity decisions building up', 'whether the book is growing'] }),
    },
    kit,
  );
}

// --- Creators ------------------------------------------------------------------------------------

export interface CreatorRosterPort {
  roster(organizationId: string): Promise<readonly { profile: { id: string }; needsEmg: number; needsCreator: number; inProduction: number; dueSoon: number }[]>;
}

interface CreatorsContext {
  readonly creators: number;
  readonly needsEmg: number;
  readonly needsCreator: number;
  readonly inProduction: number;
  readonly dueSoon: number;
  readonly waitingOnEmg: readonly string[];
}

export function creatorsRule(ctx: CreatorsContext, now: Date): RuleReading {
  const signals: IntelligenceSignal[] = [
    measured('creators', `${plural(ctx.creators, 'creator')} on the roster.`, 'creator_profiles:all', 'creators', ctx.creators, now),
    measured('in-production', `${plural(ctx.inProduction, 'production')} in progress.`, 'creator_productions:active', 'productions_in_progress', ctx.inProduction, now),
  ];
  if (ctx.needsEmg > 0) signals.push({ key: 'needs-emg', kind: 'OBLIGATION', knowledge: 'OBSERVED', owedBy: 'VIEWER', statement: `${plural(ctx.needsEmg, 'production')} waiting on EMG.`, entities: [...ctx.waitingOnEmg], evidenceRefs: ['creator_productions:active'], severity: ctx.needsEmg >= 5 ? 'HIGH' : 'MEDIUM', asOf: now.toISOString() });
  if (ctx.needsCreator > 0) signals.push({ key: 'needs-creator', kind: 'OBLIGATION', knowledge: 'OBSERVED', owedBy: 'COUNTERPARTY', statement: `${plural(ctx.needsCreator, 'production')} waiting on a creator’s review.`, evidenceRefs: ['creator_productions:active'], severity: 'LOW', asOf: now.toISOString() });
  if (ctx.dueSoon > 0) signals.push({ key: 'due-soon', kind: 'UPCOMING', knowledge: 'OBSERVED', statement: `${plural(ctx.dueSoon, 'deliverable')} due within a week or already past due.`, evidenceRefs: ['creator_deliverables:open'], severity: 'MEDIUM', asOf: now.toISOString() });
  return reading({
    statement: `${plural(ctx.inProduction, 'production')} in progress across ${plural(ctx.creators, 'creator')}${ctx.needsEmg ? `; ${ctx.needsEmg} waiting on EMG` : ''}${ctx.dueSoon ? `; ${ctx.dueSoon} deliverables due soon` : ''}.`,
    signals,
    entityRefs: [...ctx.waitingOnEmg],
    sourceId: 'LOOP_CREATORS',
    sourceRefs: ['creator_profiles:all', 'creator_productions:active', 'creator_deliverables:open'],
    evidenceCount: ctx.inProduction,
    now,
    windowStart: new Date(now.getTime() - WEEK),
  });
}

export function creatorsDomainProducer(roster: CreatorRosterPort, facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<CreatorsContext> {
  return domainProducer<CreatorsContext>(
    {
      id: 'creators.domain@1',
      domain: 'CREATORS',
      scope: 'ORGANIZATION',
      version: '1',
      provider: null,
      consentBasis: 'LOOP_RECORDS',
      discover: async () => (await facts.organizationsWithCreators().catch(() => [])).map((id) => organizationTarget(id, 'CREATORS')),
      async gather(target, now) {
        if (target.scope !== 'ORGANIZATION') return { status: 'NOT_PERMITTED', reason: 'ORGANIZATION_ONLY' };
        const rows = await roster.roster(target.organizationId);
        if (rows.length === 0) return { status: 'NO_EVIDENCE' };
        const sum = (k: 'needsEmg' | 'needsCreator' | 'inProduction' | 'dueSoon') => rows.reduce((n, r) => n + r[k], 0);
        const context: CreatorsContext = {
          creators: rows.length,
          needsEmg: sum('needsEmg'),
          needsCreator: sum('needsCreator'),
          inProduction: sum('inProduction'),
          dueSoon: sum('dueSoon'),
          waitingOnEmg: rows.filter((r) => r.needsEmg > 0).map((r) => safeRef(`creator:${r.profile.id}`)).filter((r): r is string => !!r).slice(0, 8),
        };
        return { status: 'READY', context, fingerprint: fingerprintOf('CREATORS', [now.toISOString().slice(0, 10), context]) };
      },
      rule: creatorsRule,
      model: organizationModelStage(AI_TASK_CREATORS_DOMAIN_READING, { domainDescription: "the organization's creator productions and deliverables", audience: 'ORGANIZATION', lookFor: ['what EMG owes creators', 'what is due', 'where production is stuck'] }),
    },
    kit,
  );
}

// --- Work ----------------------------------------------------------------------------------------

interface WorkContext extends WorkFacts {
  readonly personal: boolean;
}

export function workRule(ctx: WorkContext, now: Date): RuleReading {
  const you = ctx.personal;
  const signals: IntelligenceSignal[] = [measured('open', `${plural(ctx.openStages, 'open step')}${you ? ' assigned to you' : ''} across ${plural(ctx.activeInstances, 'piece of work', 'pieces of work')}.`, 'work_stages:open', 'open_steps', ctx.openStages, now)];
  const refs = ctx.overdueInstanceIds.map((id) => safeRef(`work_instance:${id}`)).filter((r): r is string => !!r);
  if (ctx.overdue > 0) signals.push({ key: 'overdue', kind: 'RISK', knowledge: 'OBSERVED', statement: `${plural(ctx.overdue, 'step')} past due.`, entities: refs, evidenceRefs: ['work_stages:overdue'], severity: 'HIGH', asOf: now.toISOString(), ...(you ? { kind: 'OBLIGATION' as const, owedBy: 'VIEWER' as const } : {}) });
  if (ctx.pastReturn > 0) signals.push({ key: 'past-return', kind: 'RISK', knowledge: 'OBSERVED', statement: `${plural(ctx.pastReturn, 'piece of work', 'pieces of work')} past the date it was committed to return.`, entities: refs, evidenceRefs: ['work_instances:past-return'], severity: 'HIGH', asOf: now.toISOString() });
  if (ctx.dueSoon > 0) signals.push({ key: 'due-soon', kind: 'UPCOMING', knowledge: 'OBSERVED', statement: `${plural(ctx.dueSoon, 'step')} due in the next day.`, evidenceRefs: ['work_stages:due-soon'], severity: 'MEDIUM', asOf: now.toISOString() });
  if (!you && ctx.unassigned > 0) signals.push({ key: 'unassigned', kind: 'ATTENTION', knowledge: 'OBSERVED', statement: `${plural(ctx.unassigned, 'ready step')} with no owner.`, evidenceRefs: ['work_stages:unassigned'], severity: ctx.unassigned >= 5 ? 'HIGH' : 'MEDIUM', asOf: now.toISOString() });
  const change = weekChange('throughput', 'Completed steps are', ctx.completed7d, ctx.completedPrior7d, 'work_stages:completed-7d', now);
  if (change) signals.push(change);
  return reading({
    statement: `${plural(ctx.openStages, 'open step')}${you ? ' on your plate' : ''}${ctx.overdue ? `, ${ctx.overdue} past due` : ''}${ctx.pastReturn ? `; ${ctx.pastReturn} past the committed return` : ''}${!you && ctx.unassigned ? `; ${ctx.unassigned} with no owner` : ''}.`,
    signals,
    entityRefs: refs,
    sourceId: 'LOOP_WORK',
    sourceRefs: ['work_stages:open', 'work_stages:overdue', 'work_instances:past-return', 'work_stages:due-soon', 'work_stages:unassigned', 'work_stages:completed-7d'],
    evidenceCount: ctx.openStages,
    now,
    windowStart: new Date(now.getTime() - WEEK),
  });
}

async function gatherWork(facts: DomainFactsRepository, organizationId: string, userId: string | null, now: Date) {
  const since = new Date(now.getTime() - WEEK);
  const f = await facts.workFacts(organizationId, userId, now, new Date(now.getTime() + DAY_MS), since, new Date(since.getTime() - WEEK));
  if (f.activeInstances === 0 && f.completed7d === 0) return { status: 'NO_EVIDENCE' } as const;
  const context: WorkContext = { ...f, personal: userId !== null };
  return { status: 'READY', context, fingerprint: fingerprintOf('WORK', [hourKey(now), context]) } as const;
}

const WORK_FRAMING = { domainDescription: "the organization's work in progress (Work OS)", audience: 'ORGANIZATION' as const, lookFor: ['what is overdue or past its commitment', 'what nobody owns', 'whether the team is keeping pace'] };

export function workDomainProducer(facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<WorkContext> {
  return domainProducer<WorkContext>(
    {
      id: 'work.domain@1',
      domain: 'WORK',
      scope: 'ORGANIZATION',
      version: '1',
      provider: null,
      consentBasis: 'LOOP_RECORDS',
      discover: async () => (await facts.organizationsWithActiveWork()).map((id) => organizationTarget(id, 'WORK')),
      gather: (target, now) => (target.scope === 'ORGANIZATION' ? gatherWork(facts, target.organizationId, null, now) : Promise.resolve({ status: 'NOT_PERMITTED', reason: 'ORGANIZATION_ONLY' } as const)),
      rule: workRule,
      model: organizationModelStage(AI_TASK_WORK_DOMAIN_READING, WORK_FRAMING),
    },
    kit,
  );
}

/** A person's own assigned work: rule reading only (their Briefing composes it; no second model call). */
export function myWorkProducer(facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<WorkContext> {
  return domainProducer<WorkContext>(
    {
      id: 'work.mine@1',
      domain: 'WORK',
      scope: 'PRINCIPAL',
      version: '1',
      provider: null,
      consentBasis: 'LOOP_RECORDS',
      discover: async () => (await facts.principalsWithOpenWork()).map((p) => ({ scope: 'PRINCIPAL', organizationId: p.organizationId, userId: p.userId, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' }) as const),
      gather: (target, now) => (target.scope === 'PRINCIPAL' ? gatherWork(facts, target.organizationId, target.userId, now) : Promise.resolve({ status: 'NOT_PERMITTED', reason: 'PRINCIPAL_ONLY' } as const)),
      rule: workRule,
    },
    kit,
  );
}

// --- Website -------------------------------------------------------------------------------------

/** Website facts one source can state for a window. Absent fields are unknown for that source. */
export interface WebsiteFacts {
  readonly sessions?: number;
  readonly formSubmits?: number;
  readonly appointmentRequests?: number;
  readonly ctaClicks?: number;
}

/**
 * One connected website evidence source. Today: Loop's own website events. A future analytics, search
 * console, ads or session-replay source implements this against Loop's governed copy of that source.
 */
export interface WebsiteEvidenceReader {
  readonly sourceId: string;
  read(organizationId: string, since: Date, until: Date): Promise<WebsiteFacts | null>;
}

export function websiteEventsReader(analytics: Pick<WebsiteAnalyticsRepository, 'getWebsiteAnalytics'>): WebsiteEvidenceReader {
  return {
    sourceId: 'WEBSITE_EVENTS',
    async read(organizationId, since, until) {
      const a = await analytics.getWebsiteAnalytics(organizationId, since, until);
      if (a.totals.events === 0) return null;
      return { sessions: a.totals.sessions, formSubmits: a.totals.formSubmits, appointmentRequests: a.totals.appointmentRequests, ctaClicks: a.totals.ctaClicks };
    },
  };
}

interface WebsiteContext {
  readonly bySource: readonly { readonly sourceId: string; readonly week: WebsiteFacts; readonly prior: WebsiteFacts | null }[];
}

const WEBSITE_METRICS: readonly [keyof WebsiteFacts, string, string, string][] = [
  ['sessions', 'sessions', 'Sessions are', 'sessions'],
  ['formSubmits', 'form submissions', 'Form submissions are', 'form_submissions'],
  ['appointmentRequests', 'appointment requests', 'Appointment requests are', 'appointment_requests'],
];

export function websiteRule(ctx: WebsiteContext, now: Date): RuleReading {
  const signals: IntelligenceSignal[] = [];
  const parts: string[] = [];
  for (const s of ctx.bySource) {
    const ref = `${s.sourceId.toLowerCase()}:7d`;
    for (const [field, noun, subject, metric] of WEBSITE_METRICS) {
      const v = s.week[field];
      if (typeof v !== 'number') continue;
      signals.push(measured(`${s.sourceId.toLowerCase()}.${metric}`, `${v} ${noun} this week.`, ref, metric, v, now));
      if (s.sourceId === ctx.bySource[0]!.sourceId) parts.push(`${v} ${noun}`);
      const before = s.prior?.[field];
      if (typeof before === 'number') {
        const c = weekChange(`${s.sourceId.toLowerCase()}.${metric}-change`, subject, v, before, ref, now);
        if (c) signals.push(field === 'sessions' ? c : { ...c, kind: (c.statement.includes(' down ') ? 'RISK' : 'OPPORTUNITY') as IntelligenceSignal['kind'] });
      }
    }
  }
  return {
    ...reading({ statement: `${parts.join(', ')} this week.`, signals, sourceId: ctx.bySource[0]!.sourceId, sourceRefs: ctx.bySource.map((s) => `${s.sourceId.toLowerCase()}:7d`), evidenceCount: ctx.bySource[0]!.week.sessions ?? 0, now, windowStart: new Date(now.getTime() - WEEK) }),
    sources: ctx.bySource.map((s) => ({ sourceId: s.sourceId, asOf: now.toISOString(), coverage: 'CONNECTED_SUFFICIENT' as const })),
    limitations: ctx.bySource.some((s) => !s.prior) ? ['A source without the week before cannot show movement yet.'] : [],
  };
}

export function websiteDomainProducer(readers: readonly WebsiteEvidenceReader[], facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<WebsiteContext> {
  return domainProducer<WebsiteContext>(
    {
      id: 'website.domain@1',
      domain: 'WEBSITE',
      scope: 'ORGANIZATION',
      version: '1',
      provider: null,
      consentBasis: 'LOOP_RECORDS',
      discover: async (now) => (await facts.organizationsWithWebsiteEvents(new Date(now.getTime() - 2 * WEEK))).map((id) => organizationTarget(id, 'WEBSITE')),
      async gather(target, now) {
        if (target.scope !== 'ORGANIZATION') return { status: 'NOT_PERMITTED', reason: 'ORGANIZATION_ONLY' };
        const since = new Date(now.getTime() - WEEK);
        const bySource = [];
        for (const r of readers) {
          const week = await r.read(target.organizationId, since, now);
          if (!week) continue;
          bySource.push({ sourceId: r.sourceId, week, prior: await r.read(target.organizationId, new Date(since.getTime() - WEEK), since) });
        }
        if (bySource.length === 0) return { status: 'NO_EVIDENCE' };
        return { status: 'READY', context: { bySource }, fingerprint: fingerprintOf('WEBSITE', [hourKey(now), bySource]) };
      },
      rule: websiteRule,
      model: organizationModelStage(AI_TASK_WEBSITE_DOMAIN_READING, { domainDescription: "the organization's website activity from its connected website sources", audience: 'ORGANIZATION', lookFor: ['whether visits and enquiries are rising or falling', 'enquiries without follow-through', 'which change matters most'] }),
    },
    kit,
  );
}
