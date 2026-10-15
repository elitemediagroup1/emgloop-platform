// The Loop Briefing: one person's Briefing, composed from what Loop already holds for them. Loop
// Intelligence Phase G, 2026-09-26.
//
//   gather     the person's OWN domain readings (Mail, Calendar, Chats, their Work), the ORGANIZATION readings
//              they may read (the domain registry's authority, resolved from their membership), and the
//              situations visible to them (their private ones; organization ones only when they may read every
//              domain each cites). Loop's own artifacts, already minimized; nothing is read from a source.
//   reuse      a fingerprint of those artifacts: if today's stored Briefing was composed from the same, it is
//              kept -- no call, no new version.
//   compose    loop.briefing.compose, when activated: a headline and up to six lines, each citing SUPPLIED
//              artifacts (briefing-contract.ts). Otherwise -- or when the model refuses or fails -- Loop's
//              DETERMINISTIC Briefing from the same artifacts, marked as such. A Briefing always exists.
//   store      a new version of today's work_brief (localDate in the person's own zone): headline, lines,
//              and a coverage record saying what was read and who composed it.
//
// Runs as the person, for the person. It proposes nothing and assigns nothing.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  AI_TASK_LOOP_BRIEFING,
  BUSINESS_TIME_ZONE,
  BRIEFING_SCHEMA,
  INTELLIGENCE_DOMAIN_REGISTRY,
  PARTIAL_COVERAGE_LIMITATION,
  absenceJustified,
  aiNumbersInText,
  digestSynthesisEligibility,
  startOfZonedDay,
  zonedCalendarDay,
  zonedParts,
  zonedWallTimeToUtc,
  rankDomainSignals,
  type AiBriefing,
  type AiContextItem,
  type AiSupportedEvidence,
  type BriefingLineKind,
  type IntelligenceCoverage,
  type IntelligenceDomain,
  type SynthesisEligibility,
} from '@emgloop/shared';

import { MarketplaceCallRepository } from '../../repositories/marketplace-call.repository';
import { callQuestionArtifact } from './call-snapshot';
import { IamRepository } from '../../repositories/iam.repository';
import { membershipAuthority } from '../../repositories/membership.repository';
import { DigestSourceStateRepository } from '../../repositories/intelligence/digest-source-state.repository';
import { IntelligenceDigestRepository, type IntelligenceDigestRecord } from '../../repositories/intelligence/intelligence-digest.repository';
import { SituationRepository, type SituationView } from '../../repositories/intelligence/situation.repository';
import { WorkBriefRepository } from '../../repositories/work-state/work-brief.repository';
import type { AiPrincipal, AiRuntimeGateway } from '../ai-runtime/gateway';
import { BRIEFING_TEMPLATE_ID, BRIEFING_TEMPLATE_VERSION, renderBriefingInstructions } from '../ai-runtime/templates/briefing';

export const BRIEFING_RECORD_SCHEMA = 'loop-briefing.v1';
export const BRIEFING_RULE_VERSION = 'loop-briefing-rule#1';
const PERSONAL: readonly IntelligenceDomain[] = ['MAIL', 'CALENDAR', 'WORK'];
const ADMIN_WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MANAGER'];

export interface BriefingArtifact {
  readonly ref: string;
  readonly domain: string;
  readonly title: string;
  readonly statement: string;
  readonly status: 'CALM' | 'WATCH' | 'ATTENTION';
  readonly signals: readonly { readonly kind: string; readonly statement: string; readonly severity?: string; readonly entities?: readonly string[]; readonly owedBy?: string; readonly dueAt?: string; readonly metric?: { readonly value: number } }[];
  readonly basis: string;
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly generatedAt?: string;
  /**
   * The artifact's coverage NOW (synthesis eligibility): only SUFFICIENT or PARTIAL artifacts exist. A
   * PARTIAL one is true of what was read, and its limitations travel with it into the Briefing.
   */
  readonly coverage: 'CONNECTED_SUFFICIENT' | 'CONNECTED_PARTIAL';
  readonly limitations: readonly string[];
}

/** A reading Loop holds for the person but may not use as current today (and why, in contract terms). */
export interface BriefingGap {
  readonly domain: string;
  readonly coverage: IntelligenceCoverage;
  /**
   * Why Loop has no current reading to state. NOT_CURRENT: a reading exists but is not current (stale,
   * disconnected, error, insufficient, unresolved refresh). NO_CURRENT_READING: Loop is expected to observe
   * this domain for the person and holds no reading at all. NOT_CONNECTED: the source it would come from is
   * not connected (or needs reconnecting). None of them is quiet.
   */
  readonly reason?: 'NOT_CURRENT' | 'NO_CURRENT_READING' | 'NOT_CONNECTED' | 'CONTEXT_LIMIT';
}

/**
 * The domains this deployment actually observes (its ACTIVE producers), by scope. Absent: assume every
 * domain may be observed -- a conservative default that can only add gaps, never remove one.
 */
export interface ObservedDomains {
  readonly principal: readonly IntelligenceDomain[];
  readonly organization: readonly IntelligenceDomain[];
}

export interface BriefingLine {
  readonly kind: BriefingLineKind;
  readonly statement: string;
  readonly citations: readonly string[];
}

export interface BriefingPorts {
  readonly prisma: PrismaClient;
  readonly runtime: Pick<AiRuntimeGateway, 'run'> | null;
  readonly modelEnabled: (taskId: string) => boolean;
  readonly now: () => Date;
  /** What this deployment observes (its active producers). Absent: the conservative default (see ObservedDomains). */
  readonly observed?: ObservedDomains;
  readonly signal?: AbortSignal;
}

export type BriefingOutcome = { readonly outcome: 'REUSED' | 'COMPOSED' | 'RULE' | 'NOTHING_TO_SAY'; readonly version?: number; readonly reason?: string };

/**
 * Which ORGANIZATION domains this member may read, from the registry's authority: the workspace (the ADMIN
 * workspace is OWNER/ADMIN/MANAGER, exactly as the web's role router maps it) and the permission (IAM).
 * The web tier decides the same from the signed session; this is the background composer's mirror.
 */
export async function readableOrganizationDomains(prisma: PrismaClient, organizationId: string, userId: string): Promise<IntelligenceDomain[]> {
  const authority = await membershipAuthority(prisma, organizationId, userId);
  if (!authority.granted || !authority.systemRole) return [];
  const iam = new IamRepository(prisma);
  const out: IntelligenceDomain[] = [];
  for (const d of INTELLIGENCE_DOMAIN_REGISTRY) {
    if (!d.scopes.includes('ORGANIZATION')) continue;
    if (d.readAuthority.workspace === 'ADMIN' && !ADMIN_WORKSPACE_ROLES.includes(authority.systemRole)) continue;
    if (d.readAuthority.workspace !== null && d.readAuthority.workspace !== 'ADMIN') continue;
    if (d.readAuthority.permission) {
      const [resource, action] = d.readAuthority.permission.split(':');
      if (!(await iam.can({ organizationId, userId, resource: resource as never, action: action as never }))) continue;
    }
    out.push(d.domain);
  }
  return out;
}

function artifactOfDigest(d: IntelligenceDigestRecord, eligibility: Extract<SynthesisEligibility, { eligible: true }>): BriefingArtifact | null {
  const statement = d.content.reading?.statement ?? d.content.synthesis ?? null;
  if (!statement) return null;
  const label = INTELLIGENCE_DOMAIN_REGISTRY.find((r) => r.domain === d.domain)?.label ?? d.domain;
  return {
    ref: `digest:${d.id}`,
    domain: d.domain,
    title: d.scope === 'PRINCIPAL' ? `Your ${label.toLowerCase()}` : label,
    statement,
    status: (d.content.reading?.status ?? 'CALM') as BriefingArtifact['status'],
    signals: rankDomainSignals(d.content.signals ?? []).slice(0, 6).map((s) => ({ kind: s.kind, statement: s.statement, ...(s.entities ? { entities: s.entities } : {}), ...(s.owedBy ? { owedBy: s.owedBy } : {}), ...(s.dueAt ? { dueAt: s.dueAt } : {}), ...(s.severity ? { severity: s.severity } : {}), ...(s.metric ? { metric: { value: s.metric.value } } : {}) })),
    basis: `${d.fingerprint}:${eligibility.coverage}`,
    windowStart: d.windowStart.toISOString(), windowEnd: d.windowEnd.toISOString(), generatedAt: d.generatedAt.toISOString(),
    coverage: eligibility.coverage,
    limitations: eligibility.limitations,
  };
}

function artifactOfSituation(s: SituationView): BriefingArtifact {
  const limitations = s.record?.limitations ?? [];
  return {
    ref: `situation:${s.id}`,
    domain: 'SITUATION',
    title: s.title,
    statement: s.summary ?? s.title,
    status: s.severity === 'HIGH' ? 'ATTENTION' : 'WATCH',
    signals: [],
    basis: `${s.record?.fingerprint ?? ''}:${s.state}:${s.lastDetectedAt.toISOString()}`,
    // A situation built on any partial reading carries that reading's limitation, and is partial.
    coverage: limitations.includes(PARTIAL_COVERAGE_LIMITATION) ? 'CONNECTED_PARTIAL' : 'CONNECTED_SUFFICIENT',
    limitations,
  };
}

const GAP_WORDS: Readonly<Record<string, string>> = Object.freeze({
  STALE: 'is out of date',
  DISCONNECTED: 'is not connected',
  ERROR: 'could not be read',
  CONNECTED_INSUFFICIENT: 'has too little to go on',
});

/** The words a Briefing carries for readings Loop could not use today. Loop's own words, no source text. */
export function gapLimitations(gaps: readonly BriefingGap[]): string[] {
  return [
    ...new Set(
      gaps.map((g) => {
        const label = g.domain === 'SITUATION' ? 'A situation' : (INTELLIGENCE_DOMAIN_REGISTRY.find((r) => r.domain === g.domain)?.label ?? g.domain);
        if (g.reason === 'CONTEXT_LIMIT') return `${label} was omitted from this bounded reading; Loop cannot conclude that it is quiet.`;
        if (g.reason === 'NOT_CONNECTED') return `${label} is not connected, so Loop cannot see it and cannot say it is quiet.`;
        if (g.reason === 'NO_CURRENT_READING') return `Loop has no current reading of ${label}, so it cannot say ${label} is quiet.`;
        return `${label} ${GAP_WORDS[g.coverage] ?? 'is not current'}, so it is not in today’s Briefing.`;
      }),
    ),
  ];
}

const TELEGRAM_LIVE = ['READY', 'CONNECTED_LIMITED'];

/**
 * THE EXPECTED-COVERAGE SET: every domain Loop is supposed to be observing for this person, and whether its
 * source is live. A domain in this set with no current reading is a GAP (never omitted), so "nothing
 * pressing" can only follow from a complete, SUFFICIENT set.
 *
 *   CHATS     the person has a Telegram connection: live when it is READY/CONNECTED_LIMITED and they
 *             authorized content reading.
 *   MAIL      the person has a Google connection: live when CONNECTED.
 *   CALENDAR  the person has a Google connection, or the deployment observes calendars: live when CONNECTED.
 *   WORK      the deployment observes a person's own work.
 *   org       every organization domain the person may read AND the deployment observes.
 *
 * A source the person never connected and the deployment does not observe is not in the set: Loop is not
 * looking there, and the Briefing's claims are always scoped to what Loop can read.
 */
export async function expectedBriefingCoverage(prisma: PrismaClient, principal: AiPrincipal, readableOrg: readonly IntelligenceDomain[], observed: ObservedDomains | undefined): Promise<{ domain: IntelligenceDomain; live: boolean }[]> {
  const obsPrincipal = observed?.principal ?? ['WORK', 'CALENDAR'];
  const obsOrg = observed?.organization ?? readableOrg;
  const [google, telegram, telegramAuth] = await Promise.all([
    prisma.googleConnection.findFirst({ where: principal, select: { status: true } }),
    prisma.sourceConnection.findFirst({ where: { ...principal, provider: 'TELEGRAM' }, select: { state: true } }),
    prisma.sourceContentAuthorization.findFirst({ where: { ...principal, provider: 'TELEGRAM', revokedAt: null }, select: { authorizedAt: true } }),
  ]);
  const out: { domain: IntelligenceDomain; live: boolean }[] = [];
  if (telegram) out.push({ domain: 'CHATS', live: TELEGRAM_LIVE.includes(telegram.state) && !!telegramAuth });
  if (google) out.push({ domain: 'MAIL', live: google.status === 'CONNECTED' });
  if (google || obsPrincipal.includes('CALENDAR')) out.push({ domain: 'CALENDAR', live: google?.status === 'CONNECTED' });
  if (obsPrincipal.includes('WORK')) out.push({ domain: 'WORK', live: true });
  for (const d of readableOrg) if (obsOrg.includes(d)) out.push({ domain: d, live: true });
  return out;
}

/** Whether today's inputs justify an ABSENCE conclusion ("nothing pressing"): all SUFFICIENT, no gaps. */
export function briefingAbsenceJustified(artifacts: readonly BriefingArtifact[], gaps: readonly BriefingGap[]): boolean {
  return gaps.length === 0 && absenceJustified(artifacts.map((a) => a.coverage));
}

/**
 * Loop's deterministic Briefing from the same artifacts: their own words, ordered, cited. A PARTIAL
 * artifact's line says it is partial. "Nothing pressing" is said ONLY when the coverage justifies an
 * absence; otherwise the headline says Loop cannot conclude that.
 */
export function ruleBriefing(artifacts: readonly BriefingArtifact[], gaps: readonly BriefingGap[] = []): { headline: string; lines: BriefingLine[]; limitations: string[] } {
  const rank = { ATTENTION: 0, WATCH: 1, CALM: 2 } as const;
  const ordered = [...artifacts].sort((a, b) => rank[a.status] - rank[b.status] || a.ref.localeCompare(b.ref));
  const lines: BriefingLine[] = ordered
    .filter((a) => a.status !== 'CALM')
    .slice(0, 6)
    .map((a) => ({
      kind: a.domain === 'SITUATION' ? 'WATCH' : a.status === 'ATTENTION' ? 'NEEDS_YOU' : 'WATCH',
      statement: `${a.title}: ${a.statement}${a.coverage === 'CONNECTED_PARTIAL' ? ' (from a partial reading)' : ''}`.slice(0, 240),
      citations: [a.ref],
    }));
  const attention = ordered.filter((a) => a.status === 'ATTENTION').length;
  const headline =
    artifacts.length === 0 && gaps.length === 0
      ? 'Loop has nothing it can read for you yet today.'
      : attention > 0
        ? `${attention} ${attention === 1 ? 'part of your work needs' : 'parts of your work need'} attention today.`
        : briefingAbsenceJustified(artifacts, gaps)
          ? 'Nothing pressing in what Loop can read for you today.'
          : 'Loop cannot say nothing is pressing today: part of what it reads for you is incomplete or not current.';
  const limitations = [...new Set([...artifacts.flatMap((a) => a.limitations), ...gapLimitations(gaps)])];
  return { headline, lines, limitations };
}

/** An absence conclusion in composed prose, refused unless the coverage justifies it. */
const ABSENCE_CLAIM = /\b(nothing (is |needs? |to )?(pressing|urgent|needs you|to do|waiting)|all clear|no (open |pressing )?(issues|action needed)|you('| a)re (all )?caught up|quiet day)\b/i;

export function briefingContextOf(artifacts: readonly BriefingArtifact[], organizationId: string) {
  const read = AI_TASK_LOOP_BRIEFING.requires[0]!;
  const items: AiContextItem[] = artifacts.map((a, i) => ({
    // Minted inside the organization (`<org>::`): the gateway refuses any other block before reserving.
    blockId: `${organizationId}::a${i}`,
    kind: 'STRUCTURED',
    trust: 'UNTRUSTED_INPUT',
    sourceRef: a.ref,
    // The coverage and limitations go to the model with the reading: a partial reading is never presented as whole.
    content: JSON.stringify({ part: a.title, status: a.status, reading: a.statement, signals: a.signals, coverage: a.coverage, limitations: a.limitations, windowStart: a.windowStart ?? null, windowEnd: a.windowEnd ?? null, generatedAt: a.generatedAt ?? null }),
    sensitivity: 'COMMUNICATION_CONTENT',
    readUnder: read,
  }));
  const figures = new Map<string, Set<number>>();
  for (const a of artifacts) {
    const set = new Set<number>(aiNumbersInText(a.statement));
    for (const s of a.signals) {
      for (const n of aiNumbersInText(s.statement)) set.add(n);
      if (s.metric) set.add(s.metric.value);
    }
    figures.set(a.ref, set);
  }
  const dates = new Set(artifacts.flatMap((a) => [...JSON.stringify(a).matchAll(/\b\d{4}-\d{2}-\d{2}(?!\d)/g)].map((m) => m[0])));
  const evidence: AiSupportedEvidence = { figures, dates };
  return { items, evidence };
}

export class BriefingComposer {
  constructor(private readonly ports: BriefingPorts) {}

  /**
   * The person's artifacts for today, and the readings Loop holds but may not use as current (gaps). A
   * digest contributes only when the synthesis-eligibility decision says it is legitimately current.
   */
  async gather(principal: AiPrincipal, now: Date, includeCallSnapshot = true): Promise<{ artifacts: BriefingArtifact[]; gaps: BriefingGap[] }> {
    const digests = new IntelligenceDigestRepository(this.ports.prisma);
    const own = await Promise.all(PERSONAL.map((d) => digests.current(principal, d, { now })));
    const chats = await digests.forDomain(principal, 'CHATS', { now, limit: 3 });
    const orgDomains = await readableOrganizationDomains(this.ports.prisma, principal.organizationId, principal.userId);
    const org = await Promise.all(orgDomains.map((d) => digests.organizationCurrent(principal.organizationId, d, { now })));
    const rows = [...own, ...chats, ...org].filter((d): d is IntelligenceDigestRecord => d !== null);
    const sources = await new DigestSourceStateRepository(this.ports.prisma).resolve(rows);
    const artifacts: BriefingArtifact[] = [];
    const gaps: BriefingGap[] = [];
    for (const d of rows) {
      const eligibility = digestSynthesisEligibility(d, sources.get(d.id) ?? { connectionLive: false, sourceLastEvidenceAt: null }, now);
      if (!eligibility.eligible) {
        gaps.push({ domain: d.domain, coverage: eligibility.coverage, reason: 'NOT_CURRENT' });
        continue;
      }
      const a = artifactOfDigest(d, eligibility);
      if (a) artifacts.push(a);
    }
    if (includeCallSnapshot && orgDomains.includes('CALLGRID')) {
      const since = startOfZonedDay(now, BUSINESS_TIME_ZONE);
      const calls = await new MarketplaceCallRepository(this.ports.prisma).aggregateWindow(principal.organizationId, since, now);
      artifacts.unshift(callQuestionArtifact(calls, since, now));
      const { year, month } = zonedParts(now, BUSINESS_TIME_ZONE);
      const baselineStart = zonedWallTimeToUtc(BUSINESS_TIME_ZONE, year, month - 1, 1);
      const baselineEnd = zonedWallTimeToUtc(BUSINESS_TIME_ZONE, year, month, 1);
      const baselineCalls = await new MarketplaceCallRepository(this.ports.prisma).aggregateHistoryWindow(principal.organizationId, baselineStart, baselineEnd);
      const baseline = callQuestionArtifact(baselineCalls, baselineStart, baselineEnd);
      artifacts.push({ ...baseline, ref: 'snapshot:callgrid:baseline', title: 'Historical baseline: last completed month', status: 'CALM', limitations: [...baseline.limitations, 'This historical baseline is stored totals only, not proof of complete source history; campaign detail is not supplied.'] });

      // A fresh, explicitly partial snapshot can stand for today's stored calls; do not describe it as a missing source.
      for (let i = gaps.length - 1; i >= 0; i--) if (gaps[i]!.domain === 'CALLGRID') gaps.splice(i, 1);
    }
    const situations = new SituationRepository(this.ports.prisma);
    const mine = await situations.open({ scope: 'PRINCIPAL', ...principal }, 3);
    const shared = (await situations.open({ scope: 'ORGANIZATION', organizationId: principal.organizationId }, 5)).filter((s) => (s.record?.domains ?? []).length > 0 && s.record!.domains.every((d) => orgDomains.includes(d as IntelligenceDomain)));
    // Every expected domain with no current reading is a gap -- never silently omitted.
    for (const e of await expectedBriefingCoverage(this.ports.prisma, principal, orgDomains, this.ports.observed)) {
      if (artifacts.some((a) => a.domain === e.domain) || gaps.some((g) => g.domain === e.domain)) continue;
      gaps.push(e.live ? { domain: e.domain, coverage: 'CONNECTED_INSUFFICIENT', reason: 'NO_CURRENT_READING' } : { domain: e.domain, coverage: 'DISCONNECTED', reason: 'NOT_CONNECTED' });
    }
    const candidates = [...artifacts, ...[...mine, ...shared].slice(0, 5).map(artifactOfSituation)];
    const selected: BriefingArtifact[] = [];
    let chars = 0;
    for (const a of candidates) {
      const length = JSON.stringify({ part: a.title, reading: a.statement, signals: a.signals, coverage: a.coverage, limitations: a.limitations }).length;
      if (selected.length >= 24 || chars + length > 24000) { gaps.push({ domain: a.domain, coverage: 'CONNECTED_PARTIAL', reason: 'CONTEXT_LIMIT' }); continue; }
      chars += length;
      selected.push(a);
    }
    return { artifacts: selected, gaps };
  }

  /** Compose (or reuse) today's Briefing for one person, in their own zone. */
  async compose(principal: AiPrincipal, timeZone: string): Promise<BriefingOutcome> {
    const now = this.ports.now();
    const localDay = zonedCalendarDay(now, timeZone);
    const localDate = new Date(`${localDay}T00:00:00.000Z`);
    const dayStart = startOfZonedDay(now, timeZone);
    const { artifacts, gaps } = await this.gather(principal, now);
    const fingerprint = `briefing:${createHash('sha256').update(JSON.stringify([BRIEFING_TEMPLATE_VERSION, localDay, artifacts.map((a) => [a.ref, a.basis]), gaps.map((g) => [g.domain, g.coverage, g.reason ?? null])])).digest('hex')}`;
    const absenceOk = briefingAbsenceJustified(artifacts, gaps);
    const carried = [...new Set([...artifacts.flatMap((a) => a.limitations), ...gapLimitations(gaps)])];
    const briefs = new WorkBriefRepository(this.ports.prisma);
    const stored = await briefs.forDate(principal, localDate, { schema: BRIEFING_RECORD_SCHEMA });
    const storedCoverage = (stored?.coverage ?? {}) as { schema?: string; fingerprint?: string; composer?: string };
    const modelOn = !!this.ports.runtime && this.ports.modelEnabled(AI_TASK_LOOP_BRIEFING.taskId);
    // Reuse: same inputs, and not a rule Briefing that the now-activated model could improve on.
    if (storedCoverage.schema === BRIEFING_RECORD_SCHEMA && storedCoverage.fingerprint === fingerprint && (storedCoverage.composer === 'MODEL' || !modelOn)) return { outcome: 'REUSED', version: stored!.version };

    let composed: {
      headline: string;
      lines: BriefingLine[];
      composer: 'MODEL' | 'RULE';
      limitations: readonly string[];
      invocationId?: string;
      providerId?: string;
      reason?: string;
    } | null = null;
    if (modelOn && artifacts.length > 0) {
      const { items, evidence } = briefingContextOf(artifacts, principal.organizationId);
      const request = {
        signal: this.ports.signal,
        task: AI_TASK_LOOP_BRIEFING,
        context: {
          organizationId: principal.organizationId,
          viewerUserId: principal.userId,
          taskId: AI_TASK_LOOP_BRIEFING.taskId,
          items,
          sensitivityCeiling: AI_TASK_LOOP_BRIEFING.sensitivityCeiling,
        },
        instructions: renderBriefingInstructions(
          items.map((i) => i.sourceRef),
          { absenceJustified: absenceOk, gaps: gapLimitations(gaps) },
        ),
        templateId: BRIEFING_TEMPLATE_ID,
        templateVersion: BRIEFING_TEMPLATE_VERSION,
        schema: BRIEFING_SCHEMA as unknown as Record<string, unknown>,
        evidence,
      };
      let result = await this.ports.runtime!.run(principal, request);
      const unjustifiedAbsence = (r: typeof result) =>
        r.outcome === 'ANSWERED' &&
        !absenceOk &&
        !!r.output.briefing &&
        [r.output.briefing.headline, ...r.output.briefing.lines.map((l) => l.statement)].some((t) =>
          ABSENCE_CLAIM.test(t),
        );
      if (
        !this.ports.signal?.aborted &&
        (result.outcome === 'REJECTED_OUTPUT' || unjustifiedAbsence(result))
      ) {
        const codes =
          result.outcome === 'REJECTED_OUTPUT'
            ? result.rejections.filter((c) => /^[A-Z_]{1,80}$/.test(c)).slice(0, 6)
            : ['UNJUSTIFIED_ABSENCE'];
        result = await this.ports.runtime!.run(principal, {
          ...request,
          templateVersion: `${BRIEFING_TEMPLATE_VERSION}.repair1`,
          instructions: `${request.instructions}\nOne bounded repair after validation codes ${codes.join(', ')}. Use only the original supplied artifacts. Return fewer, shorter lines if necessary. Omit unsupported claims or figures. Do not recommend actions or infer that nothing needs attention from incomplete coverage. Return the exact required JSON shape.`,
        });
      }
      const b: AiBriefing | null =
        result.outcome === 'ANSWERED' ? (result.output.briefing ?? null) : null;
      // An absence the coverage cannot justify is refused here, whatever the model wrote.
      const overreach =
        b !== null &&
        !absenceOk &&
        [b.headline, ...b.lines.map((l) => l.statement)].some((t) => ABSENCE_CLAIM.test(t));
      if (b && !overreach && result.outcome === 'ANSWERED') {
        composed = {
          headline: b.headline,
          lines: b.lines.map((l) => ({
            kind: l.kind,
            statement: l.statement,
            citations: l.citations,
          })),
          composer: 'MODEL',
          limitations: [...new Set([...b.limitations, ...carried])],
          invocationId: result.provenance.invocationId,
          providerId: result.provenance.requestedModel.providerId,
        };
      } else {
        const rule = ruleBriefing(artifacts, gaps);
        composed = {
          ...rule,
          composer: 'RULE',
          limitations: [
            'This is Loop’s own Briefing; the composed one was not available this time.',
            ...rule.limitations,
          ],
          reason: overreach
            ? 'UNJUSTIFIED_ABSENCE'
            : result.outcome === 'REJECTED_OUTPUT'
              ? `REJECTED_OUTPUT:${result.rejections
                  .filter((c) => /^[A-Z_]{1,80}$/.test(c))
                  .slice(0, 6)
                  .join('+')}`
              : result.outcome === 'REFUSED_BY_LOOP'
                ? `LOOP:${result.refusals[0] ?? 'REFUSED'}`
                : result.outcome,
        };
      }
    }
    if (!composed) composed = { ...ruleBriefing(artifacts, gaps), composer: 'RULE' };
    if (artifacts.length === 0 && gaps.length === 0 && stored) return { outcome: 'NOTHING_TO_SAY' };
    const written = await briefs.write(principal, {
      localDate,
      windowStart: dayStart,
      windowEnd: new Date(Math.max(now.getTime(), dayStart.getTime() + 1)),
      coverage: {
        schema: BRIEFING_RECORD_SCHEMA,
        fingerprint,
        composer: composed.composer,
        ...(composed.reason ? { modelStage: composed.reason } : {}),
        read: [...new Set(artifacts.map((a) => a.domain))].sort(),
        // What was used, how completely, and what could not be used today.
        coverages: Object.fromEntries(artifacts.map((a) => [a.ref, a.coverage])),
        notCurrent: gaps.map((g) => ({ domain: g.domain, coverage: g.coverage, reason: g.reason ?? 'NOT_CURRENT' })),
        absenceJustified: absenceOk,
        // Which part of Loop each cited artifact is from, so a surface can link a line to where it lives.
        refs: Object.fromEntries(artifacts.map((a) => [a.ref, a.domain])),
        limitations: composed.limitations,
        ...(composed.invocationId ? { invocationId: composed.invocationId, providerId: composed.providerId, taskId: AI_TASK_LOOP_BRIEFING.taskId, taskVersion: AI_TASK_LOOP_BRIEFING.version } : {}),
      },
      counts: { artifacts: artifacts.length, lines: composed.lines.length },
      items: composed.lines,
      headline: composed.headline,
      generatorVersion: composed.composer === 'MODEL' ? `${AI_TASK_LOOP_BRIEFING.taskId}#${AI_TASK_LOOP_BRIEFING.version}` : BRIEFING_RULE_VERSION,
      generatedAt: now,
    });
    return { outcome: composed.composer === 'MODEL' ? 'COMPOSED' : 'RULE', version: written.version, ...(composed.reason ? { reason: composed.reason } : {}) };
  }

  /** The people a scheduled pass composes for: members with a live reading of their own. Ids only. */
  async people(
    now: Date,
    take = 200,
  ): Promise<{ organizationId: string; userId: string; timeZone: string; hasBriefing: boolean }[]> {
    const rows = await this.ports.prisma.intelligenceDigest.findMany({
      where: {
        scope: 'PRINCIPAL',
        userId: { not: null },
        status: { not: 'WITHDRAWN' },
        expiresAt: { gt: now },
      },
      select: { organizationId: true, userId: true },
      distinct: ['organizationId', 'userId'],
      take,
    });
    const out: { organizationId: string; userId: string; timeZone: string; lastBriefAt: number }[] = [];
    for (const r of rows) {
      const principal = { organizationId: r.organizationId, userId: r.userId! };
      if (!(await membershipAuthority(this.ports.prisma, principal.organizationId, principal.userId, now)).granted) continue;
      if (!(await new IamRepository(this.ports.prisma).can({ ...principal, resource: 'employeeIntelligence', action: 'view' }))) continue;
      const prefs = await this.ports.prisma.employeeWorkPreferences.findFirst({ where: principal, select: { timeZone: true } });
      const timeZone = prefs?.timeZone ?? 'UTC';
      const localDate = new Date(`${zonedCalendarDay(now, timeZone)}T00:00:00.000Z`);
      const brief = await new WorkBriefRepository(this.ports.prisma).forDate(principal, localDate, { schema: BRIEFING_RECORD_SCHEMA });
      out.push({ ...principal, timeZone, lastBriefAt: brief?.generatedAt?.getTime() ?? 0 });
    }
    // Missing briefs first, then the oldest: a lexical rotation cannot strand an eligible viewer.
    out.sort((a, b) => a.lastBriefAt - b.lastBriefAt || `${a.organizationId}:${a.userId}`.localeCompare(`${b.organizationId}:${b.userId}`));
    return out.map(({ lastBriefAt, ...person }) => ({ ...person, hasBriefing: lastBriefAt > 0 }));
  }
}
