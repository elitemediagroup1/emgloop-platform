// Intake, People, Creators, Work and Website intelligence (Loop Intelligence Phase E, 2026-09-26). The
// organization's OWN records, read through their repositories (DomainFactsRepository and each domain's
// own) -- the same records the pages show. Counts, windows and canonical references; no names, no text.
//
//   pipeline.domain@2   Intake: ELIGIBLE Intake Records only (IntakeEligibilityRepository -- a verified website
//                       lead, or a record a person has worked: a CRM note, a status change, a Party link) by
//                       status; records entering intake this week against last; working records with no
//                       recorded human work for 14 days, each stale signal naming its longest-stalled eligible
//                       records as `customer:<id>` (so a Situation can reach them through a governed link).
//                       A Customer row is not intake: legacy ingestion residue
//                       and records nobody has worked are counted apart, never as work. `lastSeenAt` is not read.
//   crm.domain@1        People: established people and companies; records awaiting a decision; newly
//                       established this week against last; relationships started and ended.
//   creators.domain@1   Creator Hub: productions waiting on EMG, waiting on a creator, deliverables due.
//   work.domain@1       the organization's work: open, unassigned, overdue, past its committed return,
//                       completed this week against last.   (ORGANIZATION) The overdue and past-return signals
//                       each name only the instances their own fact is about: Work's state. A promoted Work
//                       item is named only when Work itself says it is late -- the promotion is a link, never
//                       a second source.
//   work.mine@1         a person's own assigned work, the same facts for them.   (PRINCIPAL)
//   website.domain@2    website activity from Loop's OWN website events (every admitted event, exact counts):
//                       sessions, page views (PAGE_VIEW-class events only), form submissions, appointment
//                       requests, this week against last.
//
// WEBSITE IS FIRST-PARTY ONLY, NOT SOURCE-FAKED. Google Analytics 4, Search Console, Bing Webmaster and Clarity
// are DECLARED in the source registry and connected for no one: they contribute no reading, no figure and no
// signal. A reading only NAMES them, in a limitation, as not connected -- coverage, never a performance
// conclusion. A connector reads Loop's governed aggregates (source_metric_windows) in a later, separate change.

import { SIGNAL_ENTITIES_MAX, entityRefRefusal, AI_TASK_CREATORS_DOMAIN_READING, AI_TASK_CRM_DOMAIN_READING, AI_TASK_PIPELINE_DOMAIN_READING, AI_TASK_WEBSITE_DOMAIN_READING, AI_TASK_WORK_DOMAIN_READING, type IntelligenceSignal } from '@emgloop/shared';

import type { CrmRepository } from '../../../repositories/crm.repository';
import { INTAKE_STALE_DAYS, INTAKE_WORKING, intakeCountsOf, type IntakeCounts, type IntakeEligibilityRepository, type IntakeRead } from '../../../repositories/intake-eligibility.repository';
import type { DomainFactsRepository, WorkFacts } from '../../../repositories/intelligence/domain-facts.repository';
import type { WebsiteAnalyticsRepository } from '../../../repositories/website-analytics.repository';
import type { IntelligenceProducer } from '../producer';
import { domainProducer, type DomainKitPorts, type RuleReading } from '../domain-kit';
import { comparableChange, DAY_MS, fingerprintOf, organizationModelStage, organizationTarget, plural, safeRef } from './organization-kit';

const WEEK = 7 * DAY_MS;

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
  readonly intake: IntakeCounts;
  /** Records that entered intake in the last 7 days, and in the 7 before. */
  readonly entered: { readonly week: number; readonly prior: number };
  /** The latest governed clock (work, or entry) across eligible records; null when there are none. */
  readonly latestClockAt: string | null;
  /**
   * The stalled ELIGIBLE records each stale signal names, as `customer:<id>` (longest-stalled first, at most
   * SIGNAL_ENTITIES_MAX): how a Pipeline reading takes part in a Situation. Never a record that is not intake.
   */
  readonly stalledRefs: Readonly<Record<'New' | 'Contacted' | 'Quoted', readonly string[]>>;
  readonly week: { readonly conversations: number; readonly conversationsAssigned: number };
}

export function pipelineContextOf(read: IntakeRead, now: Date, week: { conversations: number; conversationsAssigned: number }): PipelineContext {
  const since = now.getTime() - WEEK;
  const entered = { week: 0, prior: 0 };
  let latest = 0;
  for (const r of read.records) {
    const t = r.enteredAt.getTime();
    if (t >= since && t < now.getTime()) entered.week += 1;
    else if (t >= since - WEEK && t < since) entered.prior += 1;
    latest = Math.max(latest, r.clockAt.getTime());
  }
  const stalledRefs = { New: [] as string[], Contacted: [] as string[], Quoted: [] as string[] };
  const stalled = read.records.filter((r) => r.stalled).sort((a, b) => a.clockAt.getTime() - b.clockAt.getTime() || a.id.localeCompare(b.id));
  for (const r of stalled) {
    const list = stalledRefs[r.status as 'New' | 'Contacted' | 'Quoted'];
    const reference = `customer:${r.id}`;
    if (list && list.length < SIGNAL_ENTITIES_MAX && entityRefRefusal(reference, 'ORGANIZATION') === null) list.push(reference);
  }
  return { intake: intakeCountsOf(read), entered, latestClockAt: latest ? new Date(latest).toISOString() : null, week, stalledRefs };
}

export function pipelineRule(ctx: PipelineContext, now: Date): RuleReading {
  const ref = 'intake:status';
  const { intake } = ctx;
  const stalledTotal = INTAKE_WORKING.reduce((n, s) => n + intake.stalled[s as 'New' | 'Contacted' | 'Quoted'], 0);
  const signals: IntelligenceSignal[] = [
    measured('working', `${plural(intake.working, 'intake record')} in a working status (New, Contacted or Quoted).`, ref, 'working_records', intake.working, now),
    measured('entered-week', `${plural(ctx.entered.week, 'record')} entered intake this week.`, 'intake:entered:7d', 'entered_records', ctx.entered.week, now),
    measured('booked', `${plural(intake.byStatus.Booked, 'intake record')} booked.`, ref, 'booked_records', intake.byStatus.Booked, now),
  ];
  const change = weekChange('entered-change', 'Records entering intake are', ctx.entered.week, ctx.entered.prior, 'intake:entered:7d', now);
  if (change) signals.push(change);
  for (const status of INTAKE_WORKING) {
    const n = intake.stalled[status as 'New' | 'Contacted' | 'Quoted'];
    const named = ctx.stalledRefs[status as 'New' | 'Contacted' | 'Quoted'];
    if (n > 0) signals.push({ key: `stale.${status.toLowerCase()}`, kind: 'STALLED', knowledge: 'OBSERVED', statement: `${plural(n, 'intake record')} in ${status} with no recorded work for ${INTAKE_STALE_DAYS} days.`, ...(named.length ? { entities: [...named] } : {}), evidenceRefs: [`intake:stale:${status.toLowerCase()}`], severity: status === 'Quoted' || n >= 10 ? 'HIGH' : 'MEDIUM', asOf: now.toISOString() });
  }
  if (intake.byStatus.UNSET > 0) signals.push({ key: 'status-unset', kind: 'ATTENTION', knowledge: 'OBSERVED', statement: `${plural(intake.byStatus.UNSET, 'worked record')} with no intake status set.`, evidenceRefs: [ref], severity: 'LOW', asOf: now.toISOString() });
  const unassigned = ctx.week.conversations - ctx.week.conversationsAssigned;
  if (ctx.week.conversations > 0 && unassigned > 0) signals.push({ key: 'unassigned-conversations', kind: 'ATTENTION', knowledge: 'OBSERVED', statement: `${plural(unassigned, 'conversation')} opened this week with no one assigned.`, evidenceRefs: ['conversations:7d'], severity: unassigned >= 5 ? 'HIGH' : 'MEDIUM', asOf: now.toISOString() });
  const limitations: string[] = [];
  if (intake.excluded > 0) limitations.push(`${plural(intake.excluded, 'other record')} ${intake.excluded === 1 ? 'is' : 'are'} not counted as intake: nobody has worked ${intake.excluded === 1 ? 'it' : 'them'} and ${intake.excluded === 1 ? 'it' : 'they'} did not arrive as a website lead.`);
  if (!intake.complete) limitations.push('Not every intake record could be read, so these counts are a lower bound.');
  return {
    ...reading({
      statement: `${plural(intake.working, 'intake record')} in progress, ${ctx.entered.week} new this week${stalledTotal ? `; ${stalledTotal} with no recorded work for ${INTAKE_STALE_DAYS} days` : ''}.`,
      signals,
      limitations,
      sourceId: 'LOOP_INTAKE',
      entityRefs: [...new Set(INTAKE_WORKING.flatMap((s) => ctx.stalledRefs[s as 'New' | 'Contacted' | 'Quoted']))],
      sourceRefs: [ref, 'intake:entered:7d', 'conversations:7d', ...INTAKE_WORKING.map((s) => `intake:stale:${s.toLowerCase()}`)],
      evidenceCount: intake.eligible,
      now,
      windowStart: new Date(now.getTime() - WEEK),
    }),
    // Evidence is as recent as the latest governed work or entry -- never the time of the read.
    lastEvidenceAt: ctx.latestClockAt ? new Date(ctx.latestClockAt) : null,
    ...(intake.complete ? {} : { coverage: 'CONNECTED_PARTIAL' as const }),
  };
}

export function pipelineDomainProducer(crm: Pick<CrmRepository, 'windowCounts'>, intake: Pick<IntakeEligibilityRepository, 'read'>, facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<PipelineContext> {
  return domainProducer<PipelineContext>(
    {
      // @2 (2026-09-29): intake eligibility and the work clock; a Customer row is no longer intake. A NEW id on
      // purpose: an activation list that still names pipeline.domain@1 matches nothing, so deploying this can
      // never start the repaired reading -- running it is an explicit LOOP_INTELLIGENCE_PRODUCERS change.
      id: 'pipeline.domain@2',
      domain: 'PIPELINE',
      scope: 'ORGANIZATION',
      // 3 (2026-09-29): stale signals name their stalled eligible records (`customer:<id>`) for Situations.
      version: '3',
      provider: null,
      consentBasis: 'LOOP_RECORDS',
      discover: async () => (await facts.organizationsWithCustomers()).map((id) => organizationTarget(id, 'PIPELINE')),
      async gather(target, now) {
        if (target.scope !== 'ORGANIZATION') return { status: 'NOT_PERMITTED', reason: 'ORGANIZATION_ONLY' };
        const org = target.organizationId;
        const [read, week] = await Promise.all([intake.read(org, now), crm.windowCounts(org, new Date(now.getTime() - WEEK), now)]);
        // No eligible record: there is no intake to read (the rows that exist are not intake work).
        if (read.records.length === 0) return { status: 'NO_EVIDENCE' };
        const context = pipelineContextOf(read, now, { conversations: week.conversations, conversationsAssigned: week.conversationsAssigned });
        return { status: 'READY', context, fingerprint: fingerprintOf('PIPELINE', ['v3', now.toISOString().slice(0, 10), context]) };
      },
      rule: pipelineRule,
      model: organizationModelStage(AI_TASK_PIPELINE_DOMAIN_READING, { domainDescription: "the organization's intake records -- those that arrived as website leads or that people have worked -- and their statuses", audience: 'ORGANIZATION', lookFor: ['records that are stuck', 'whether new demand is rising or falling', 'conversations nobody owns'] }),
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
  // Each signal names only the work its own fact is about -- Work's state, never a promoted origin's claim.
  const named = (ids: readonly string[]) => ids.map((id) => safeRef(`work_instance:${id}`)).filter((r): r is string => !!r);
  const overdueRefs = named(ctx.overdueInstanceIds);
  const pastReturnRefs = named(ctx.pastReturnInstanceIds);
  const refs = [...new Set([...overdueRefs, ...pastReturnRefs])];
  if (ctx.overdue > 0) signals.push({ key: 'overdue', kind: 'RISK', knowledge: 'OBSERVED', statement: `${plural(ctx.overdue, 'step')} past due.`, ...(overdueRefs.length ? { entities: overdueRefs } : {}), evidenceRefs: ['work_stages:overdue'], severity: 'HIGH', asOf: now.toISOString(), ...(you ? { kind: 'OBLIGATION' as const, owedBy: 'VIEWER' as const } : {}) });
  if (ctx.pastReturn > 0) signals.push({ key: 'past-return', kind: 'RISK', knowledge: 'OBSERVED', statement: `${plural(ctx.pastReturn, 'piece of work', 'pieces of work')} past the date it was committed to return.`, ...(pastReturnRefs.length ? { entities: pastReturnRefs } : {}), evidenceRefs: ['work_instances:past-return'], severity: 'HIGH', asOf: now.toISOString() });
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
      // 2 (2026-09-29): overdue and past-return each name only their own instances (they shared one list).
      version: '2',
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
      // 2 (2026-09-29): overdue and past-return each name only their own instances (they shared one list).
      version: '2',
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

/**
 * Website facts one source states for a window. A field that is ABSENT is unknown for that source -- never
 * zero: a count the source could not read in full is omitted rather than reported short.
 */
export interface WebsiteFacts {
  readonly sessions?: number;
  readonly pageViews?: number;
  readonly formSubmits?: number;
  readonly appointmentRequests?: number;
  readonly ctaClicks?: number;
}

/**
 * The one website evidence source website.domain@2 reads: Loop's own website events. An external source
 * (GA4, Search Console, Bing Webmaster, Clarity) will read Loop's governed copy of its aggregates
 * (source_metric_windows) -- none is connected, so none is read, and no reading carries a figure from one.
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
      return {
        sessions: a.totals.sessions,
        pageViews: a.totals.pageViews,
        formSubmits: a.totals.formSubmits,
        appointmentRequests: a.totals.appointmentRequests,
        ctaClicks: a.totals.ctaClicks,
      };
    },
  };
}

/** The labels of the declared external website sources this organization has NOT connected. */
export interface WebsiteCoveragePort {
  unconnectedSources(organizationId: string, now: Date): Promise<readonly string[]>;
}

interface WebsiteContext {
  readonly bySource: readonly { readonly sourceId: string; readonly week: WebsiteFacts; readonly prior: WebsiteFacts | null }[];
  /** Registry labels of declared website sources not connected for this organization. */
  readonly unconnected?: readonly string[];
}

const WEBSITE_METRICS: readonly [keyof WebsiteFacts, string, string, string][] = [
  ['sessions', 'sessions', 'Sessions are', 'sessions'],
  ['pageViews', 'page views', 'Page views are', 'page_views'],
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
        if (c) signals.push(field === 'sessions' || field === 'pageViews' ? c : { ...c, kind: (c.statement.includes(' down ') ? 'RISK' : 'OPPORTUNITY') as IntelligenceSignal['kind'] });
      }
    }
  }
  const limitations: string[] = [];
  if (ctx.bySource.some((s) => !s.prior)) limitations.push('A source without the week before cannot show movement yet.');
  // Coverage, stated as coverage: a source that is not connected says nothing about the website's performance.
  if (ctx.unconnected && ctx.unconnected.length > 0) {
    limitations.push(`Not connected, so not read: ${ctx.unconnected.join(', ')}. This reading uses Loop's own website events only.`);
  }
  return {
    ...reading({ statement: `${parts.join(', ')} this week.`, signals, sourceId: ctx.bySource[0]!.sourceId, sourceRefs: ctx.bySource.map((s) => `${s.sourceId.toLowerCase()}:7d`), evidenceCount: ctx.bySource[0]!.week.sessions ?? 0, now, windowStart: new Date(now.getTime() - WEEK) }),
    sources: ctx.bySource.map((s) => ({ sourceId: s.sourceId, asOf: now.toISOString(), coverage: 'CONNECTED_SUFFICIENT' as const })),
    limitations,
  };
}

export function websiteDomainProducer(firstParty: WebsiteEvidenceReader, coverage: WebsiteCoveragePort | null, facts: DomainFactsRepository, kit: DomainKitPorts): IntelligenceProducer<WebsiteContext> {
  if (firstParty.sourceId !== 'WEBSITE_EVENTS') throw new Error('website.domain@2 reads first-party website events only');
  return domainProducer<WebsiteContext>(
    {
      // @2 (2026-09-30): FIRST-PARTY evidence only, tenancy from registered properties, counts read from every
      // admitted website event (sessions and page views were never Interactions, so @1 read them as zero),
      // heartbeat / scroll / identify never counted as page views, and a coverage
      // limitation naming the declared website sources not connected. A NEW id on purpose: an activation list
      // naming website.domain@1 matches nothing, so running this is an explicit LOOP_INTELLIGENCE_PRODUCERS change.
      id: 'website.domain@2',
      domain: 'WEBSITE',
      scope: 'ORGANIZATION',
      version: '2',
      provider: null,
      consentBasis: 'LOOP_RECORDS',
      discover: async (now) => (await facts.organizationsWithWebsiteEvents(new Date(now.getTime() - 2 * WEEK))).map((id) => organizationTarget(id, 'WEBSITE')),
      async gather(target, now) {
        if (target.scope !== 'ORGANIZATION') return { status: 'NOT_PERMITTED', reason: 'ORGANIZATION_ONLY' };
        const since = new Date(now.getTime() - WEEK);
        const week = await firstParty.read(target.organizationId, since, now);
        if (!week) return { status: 'NO_EVIDENCE' };
        const prior = await firstParty.read(target.organizationId, new Date(since.getTime() - WEEK), since);
        const bySource = [{ sourceId: firstParty.sourceId, week, prior }];
        const unconnected = coverage ? [...(await coverage.unconnectedSources(target.organizationId, now))] : [];
        return { status: 'READY', context: { bySource, unconnected }, fingerprint: fingerprintOf('WEBSITE', [hourKey(now), bySource, unconnected]) };
      },
      rule: websiteRule,
      model: organizationModelStage(AI_TASK_WEBSITE_DOMAIN_READING, { domainDescription: "the organization's website activity from Loop's own website events", audience: 'ORGANIZATION', lookFor: ['whether visits and enquiries are rising or falling', 'enquiries without follow-through', 'which change matters most'] }),
    },
    kit,
  );
}
