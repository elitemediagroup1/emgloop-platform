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
  BRIEFING_SCHEMA,
  INTELLIGENCE_DOMAIN_REGISTRY,
  aiNumbersInText,
  startOfZonedDay,
  zonedCalendarDay,
  type AiBriefing,
  type AiContextItem,
  type AiSupportedEvidence,
  type BriefingLineKind,
  type IntelligenceDomain,
} from '@emgloop/shared';

import { IamRepository } from '../../repositories/iam.repository';
import { membershipAuthority } from '../../repositories/membership.repository';
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
  readonly signals: readonly { readonly kind: string; readonly statement: string; readonly severity?: string; readonly metric?: { readonly value: number } }[];
  readonly basis: string;
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

function artifactOfDigest(d: IntelligenceDigestRecord): BriefingArtifact | null {
  const statement = d.content.reading?.statement ?? d.content.synthesis ?? null;
  if (!statement) return null;
  const label = INTELLIGENCE_DOMAIN_REGISTRY.find((r) => r.domain === d.domain)?.label ?? d.domain;
  return {
    ref: `digest:${d.id}`,
    domain: d.domain,
    title: d.scope === 'PRINCIPAL' ? `Your ${label.toLowerCase()}` : label,
    statement,
    status: (d.content.reading?.status ?? 'CALM') as BriefingArtifact['status'],
    signals: (d.content.signals ?? []).slice(0, 4).map((s) => ({ kind: s.kind, statement: s.statement, ...(s.severity ? { severity: s.severity } : {}), ...(s.metric ? { metric: { value: s.metric.value } } : {}) })),
    basis: d.fingerprint,
  };
}

function artifactOfSituation(s: SituationView): BriefingArtifact {
  return {
    ref: `situation:${s.id}`,
    domain: 'SITUATION',
    title: s.title,
    statement: s.summary ?? s.title,
    status: s.severity === 'HIGH' ? 'ATTENTION' : 'WATCH',
    signals: [],
    basis: `${s.record?.fingerprint ?? ''}:${s.state}:${s.lastDetectedAt.toISOString()}`,
  };
}

/** Loop's deterministic Briefing from the same artifacts: their own words, ordered, cited. */
export function ruleBriefing(artifacts: readonly BriefingArtifact[]): { headline: string; lines: BriefingLine[] } {
  const rank = { ATTENTION: 0, WATCH: 1, CALM: 2 } as const;
  const ordered = [...artifacts].sort((a, b) => rank[a.status] - rank[b.status] || a.ref.localeCompare(b.ref));
  const lines: BriefingLine[] = ordered
    .filter((a) => a.status !== 'CALM')
    .slice(0, 6)
    .map((a) => ({ kind: a.domain === 'SITUATION' ? 'WATCH' : a.status === 'ATTENTION' ? 'NEEDS_YOU' : 'WATCH', statement: `${a.title}: ${a.statement}`.slice(0, 240), citations: [a.ref] }));
  const attention = ordered.filter((a) => a.status === 'ATTENTION').length;
  const headline =
    artifacts.length === 0
      ? 'Loop has nothing it can read for you yet today.'
      : attention > 0
        ? `${attention} ${attention === 1 ? 'part of your work needs' : 'parts of your work need'} attention today.`
        : 'Nothing pressing in what Loop can read for you today.';
  return { headline, lines };
}

function contextOf(artifacts: readonly BriefingArtifact[]) {
  const read = AI_TASK_LOOP_BRIEFING.requires[0]!;
  const items: AiContextItem[] = artifacts.map((a, i) => ({
    blockId: `a${i}`,
    kind: 'STRUCTURED',
    trust: 'UNTRUSTED_INPUT',
    sourceRef: a.ref,
    content: JSON.stringify({ part: a.title, status: a.status, reading: a.statement, signals: a.signals }),
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
  const evidence: AiSupportedEvidence = { figures, dates: new Set() };
  return { items, evidence };
}

export class BriefingComposer {
  constructor(private readonly ports: BriefingPorts) {}

  async gather(principal: AiPrincipal, now: Date): Promise<BriefingArtifact[]> {
    const digests = new IntelligenceDigestRepository(this.ports.prisma);
    const own = await Promise.all(PERSONAL.map((d) => digests.current(principal, d, { now })));
    const chats = await digests.forDomain(principal, 'CHATS', { now, limit: 3 });
    const orgDomains = await readableOrganizationDomains(this.ports.prisma, principal.organizationId, principal.userId);
    const org = await Promise.all(orgDomains.map((d) => digests.organizationCurrent(principal.organizationId, d, { now })));
    const situations = new SituationRepository(this.ports.prisma);
    const mine = await situations.open({ scope: 'PRINCIPAL', ...principal }, 3);
    const shared = (await situations.open({ scope: 'ORGANIZATION', organizationId: principal.organizationId }, 5)).filter((s) => (s.record?.domains ?? []).length > 0 && s.record!.domains.every((d) => orgDomains.includes(d as IntelligenceDomain)));
    return [
      ...[...own, ...chats, ...org].flatMap((d) => (d ? [artifactOfDigest(d)].filter((a): a is BriefingArtifact => a !== null) : [])),
      ...[...mine, ...shared].slice(0, 5).map(artifactOfSituation),
    ].slice(0, 24);
  }

  /** Compose (or reuse) today's Briefing for one person, in their own zone. */
  async compose(principal: AiPrincipal, timeZone: string): Promise<BriefingOutcome> {
    const now = this.ports.now();
    const localDay = zonedCalendarDay(now, timeZone);
    const localDate = new Date(`${localDay}T00:00:00.000Z`);
    const dayStart = startOfZonedDay(now, timeZone);
    const artifacts = await this.gather(principal, now);
    const fingerprint = `briefing:${createHash('sha256').update(JSON.stringify([localDay, artifacts.map((a) => [a.ref, a.basis])])).digest('hex')}`;
    const briefs = new WorkBriefRepository(this.ports.prisma);
    const stored = await briefs.forDate(principal, localDate);
    const storedCoverage = (stored?.coverage ?? {}) as { schema?: string; fingerprint?: string; composer?: string };
    const modelOn = !!this.ports.runtime && this.ports.modelEnabled(AI_TASK_LOOP_BRIEFING.taskId);
    // Reuse: same inputs, and not a rule Briefing that the now-activated model could improve on.
    if (storedCoverage.schema === BRIEFING_RECORD_SCHEMA && storedCoverage.fingerprint === fingerprint && (storedCoverage.composer === 'MODEL' || !modelOn)) return { outcome: 'REUSED', version: stored!.version };

    let composed: { headline: string; lines: BriefingLine[]; composer: 'MODEL' | 'RULE'; limitations: readonly string[]; invocationId?: string; providerId?: string; reason?: string } | null = null;
    if (modelOn && artifacts.length > 0) {
      const { items, evidence } = contextOf(artifacts);
      const result = await this.ports.runtime!.run(principal, {
        task: AI_TASK_LOOP_BRIEFING,
        context: { organizationId: principal.organizationId, viewerUserId: principal.userId, taskId: AI_TASK_LOOP_BRIEFING.taskId, items, sensitivityCeiling: AI_TASK_LOOP_BRIEFING.sensitivityCeiling },
        instructions: renderBriefingInstructions(items.map((i) => i.sourceRef)),
        templateId: BRIEFING_TEMPLATE_ID,
        templateVersion: BRIEFING_TEMPLATE_VERSION,
        schema: BRIEFING_SCHEMA as unknown as Record<string, unknown>,
        evidence,
      });
      if (result.outcome === 'ANSWERED' && result.output.briefing) {
        const b: AiBriefing = result.output.briefing;
        composed = { headline: b.headline, lines: b.lines.map((l) => ({ kind: l.kind, statement: l.statement, citations: l.citations })), composer: 'MODEL', limitations: b.limitations, invocationId: result.provenance.invocationId, providerId: result.provenance.requestedModel.providerId };
      } else {
        composed = { ...ruleBriefing(artifacts), composer: 'RULE', limitations: ['This is Loop’s own Briefing; the composed one was not available this time.'], reason: result.outcome === 'REFUSED_BY_LOOP' ? `LOOP:${result.refusals[0] ?? 'REFUSED'}` : result.outcome };
      }
    }
    if (!composed) composed = { ...ruleBriefing(artifacts), composer: 'RULE', limitations: [] };
    if (artifacts.length === 0 && stored) return { outcome: 'NOTHING_TO_SAY' };
    const written = await briefs.write(principal, {
      localDate,
      windowStart: dayStart,
      windowEnd: new Date(Math.max(now.getTime(), dayStart.getTime() + 1)),
      coverage: {
        schema: BRIEFING_RECORD_SCHEMA,
        fingerprint,
        composer: composed.composer,
        read: [...new Set(artifacts.map((a) => a.domain))].sort(),
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
  async people(now: Date, take = 200): Promise<{ organizationId: string; userId: string; timeZone: string }[]> {
    const rows = await this.ports.prisma.intelligenceDigest.findMany({
      where: { scope: 'PRINCIPAL', userId: { not: null }, status: { not: 'WITHDRAWN' }, expiresAt: { gt: now } },
      select: { organizationId: true, userId: true },
      distinct: ['organizationId', 'userId'],
      take,
    });
    const out = [];
    for (const r of rows) {
      const prefs = await this.ports.prisma.employeeWorkPreferences.findFirst({ where: { organizationId: r.organizationId, userId: r.userId! }, select: { timeZone: true } });
      out.push({ organizationId: r.organizationId, userId: r.userId!, timeZone: prefs?.timeZone ?? 'UTC' });
    }
    return out;
  }
}
