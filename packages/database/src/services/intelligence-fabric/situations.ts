// Situation synthesis: connected business situations across domains, held as Cases. Loop Intelligence
// Phase F, 2026-09-26.
//
//   gather     the owner's CURRENT digests -- the organization's readings for an ORGANIZATION pass; the
//              person's own (Chats, Mail, Calendar, their Work) for a PRINCIPAL pass -- and the explicit
//              entity links the owner may see. Loop's own artifacts only; no source is read.
//   cluster    deterministically (clusterSituationSignals): shared canonical entities, explicit entity_links, or
//              links PROJECTED from governed records (GovernedEntityLinkProjector: an active Customer->Party
//              link, a Creator's Party, a Work item's promoted origin -- organization passes only), within the
//              temporal window, across at least two domains. No model decides what to look at.
//   source independence  only a cluster whose evidence rests on at least two DISTINCT GOVERNED SOURCES is
//              synthesized. A signal's source is its digest's one registered provenance source (signalSourcesOf;
//              a multi-source digest's signals claim none). CallGrid and Campaigns both read the one CALLGRID
//              source: together they are one source seen twice, never corroboration. A link -- explicit or
//              projected, a WorkOrigin included -- only joins entities; it is never a source. Evidence-source
//              independence is NOT verification independence (below): different controls, different problems.
//   skip       a cluster whose fingerprint equals the last decided one costs nothing (situation_candidates).
//   synthesize situation.synthesis[.private]: NEW / UPDATE (a SUPPLIED open situation) / NONE, with claims
//              citing supplied signal refs -- validated by the registered contract before this sees it.
//   verify     situation.verify[.private], routed OTHER_THAN_SUBJECT: a different MODEL PROVIDER marks each claim.
//              With none commissioned the check does not run and the situation records UNAVAILABLE -- it is
//              never checked by the same provider and called independent. If an independent check finds NO
//              claim supported, the situation is not recorded.
//   record     SituationRepository (the Case authority): the ORGANIZATION's Case, or the person's PRIVATE one.
//
// VISIBILITY IS THE MOST RESTRICTIVE EVIDENCE'S. A PRINCIPAL pass reads that person's private digests, so
// its situations are PRIVATE. An ORGANIZATION pass reads only organization digests, so its are the
// organization's. (A private pass does not read organization readings today: which ones a person may open
// is decided from their session in the web tier, and this pass has no session.)

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  AI_TASK_PRIVATE_SITUATION_SYNTHESIS,
  AI_TASK_PRIVATE_SITUATION_VERIFICATION,
  AI_TASK_SITUATION_SYNTHESIS,
  AI_TASK_SITUATION_VERIFICATION,
  INTELLIGENCE_DOMAIN_REGISTRY,
  SITUATION_SIGNAL_KINDS,
  intelligenceSourceEntry,
  SITUATION_SYNTHESIS_SCHEMA,
  SITUATION_VERIFICATION_SCHEMA,
  aiNumbersInText,
  clusterSituationSignals,
  digestSynthesisEligibility,
  type SynthesisSourceState,
  type AiContextItem,
  type AiSituationSynthesis,
  type IntelligenceDomain,
  type SituationClusterCandidate,
  type SituationEvidence,
  type SituationSignalInput,
  type SituationVerificationState,
} from '@emgloop/shared';

import { DigestSourceStateRepository } from '../../repositories/intelligence/digest-source-state.repository';
import { EntityLinkRepository, type EntityLinkOwner } from '../../repositories/intelligence/entity-link.repository';
import { IntelligenceDigestRepository, type IntelligenceDigestRecord } from '../../repositories/intelligence/intelligence-digest.repository';
import { GovernedEntityLinkProjector, type GovernedLinkClassCount } from '../../repositories/intelligence/governed-entity-links.repository';
import { SituationConnectivityRepository, type GovernedConnectivity } from '../../repositories/intelligence/situation-connectivity.repository';
import { SituationRepository, SITUATION_RECORD_SCHEMA, type SituationOwner, type SituationRecord, type SituationView } from '../../repositories/intelligence/situation.repository';
import type { AiPrincipal, AiRuntimeGateway } from '../ai-runtime/gateway';
import {
  SITUATION_SYNTHESIS_TEMPLATE_ID,
  SITUATION_TEMPLATE_VERSION,
  SITUATION_VERIFICATION_TEMPLATE_ID,
  renderSituationSynthesisInstructions,
  renderSituationVerificationInstructions,
} from '../ai-runtime/templates/situations';

const PERSONAL_DOMAINS: readonly IntelligenceDomain[] = ['CHATS', 'MAIL', 'CALENDAR', 'WORK'];
const ORGANIZATION_DOMAINS: readonly IntelligenceDomain[] = INTELLIGENCE_DOMAIN_REGISTRY.filter((d) => d.scopes.includes('ORGANIZATION')).map((d) => d.domain);
const DIGESTS_PER_DOMAIN = 20;
const OFFERED_SITUATIONS = 3;

export interface SituationPorts {
  readonly prisma: PrismaClient;
  readonly runtime: Pick<AiRuntimeGateway, 'run'> | null;
  /** Whether the task is ACTIVATED in this deployment. False: no call at all. */
  readonly modelEnabled: (taskId: string) => boolean;
  /** Who the pass runs as: the person for PRINCIPAL; the named acting operator for ORGANIZATION. */
  readonly principalFor: (owner: SituationOwner) => Promise<AiPrincipal | null>;
  readonly now: () => Date;
}

export interface SituationPassReport {
  readonly state: 'NOT_MIGRATED' | 'RAN';
  readonly candidates: number;
  /** Candidates not read because their evidence rests on fewer than two distinct governed SOURCES (not a verification outcome). */
  readonly sameSourceOnly: number;
  readonly unchanged: number;
  readonly notAsked: number;
  readonly decisions: Readonly<Record<string, number>>;
  readonly verification: Readonly<Record<string, number>>;
  readonly refused: Readonly<Record<string, number>>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SEVERITY: Readonly<Record<string, number>> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

function signalTime(signal: { occurredAt?: string; dueAt?: string; asOf?: string }, fallback: Date): number {
  for (const v of [signal.occurredAt, signal.dueAt, signal.asOf]) {
    const t = v ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return fallback.getTime();
}

/**
 * THE SOURCE LINEAGE RULE. A digest's governed sources are the REGISTERED source ids its provenance names
 * (INTELLIGENCE_SOURCE_REGISTRY) -- what its producer actually read. An unregistered or missing source id is
 * dropped: such a digest can still connect, but contributes nothing to independence (fail closed).
 */
export function governedSourcesOf(digest: Pick<IntelligenceDigestRecord, 'provenance'>): string[] {
  const ids = ((digest.provenance as { sources?: { sourceId?: unknown }[] } | undefined)?.sources ?? []).map((x) => x.sourceId);
  return [...new Set(ids.filter((x): x is string => typeof x === 'string' && intelligenceSourceEntry(x) !== null))].sort();
}

/**
 * The governed sources ONE SIGNAL rests on. Provenance is recorded per digest, not per signal, so a signal can
 * inherit it only when the digest read exactly one governed source: then every claim in it came from there. A
 * digest that read several (Website with more than one connected reader) cannot say which source each signal
 * came from, and handing every signal all of them would let one source's claim count as two -- so its signals
 * get none: they may still connect, but never make a cluster independent (fail closed).
 */
export function signalSourcesOf(digest: Pick<IntelligenceDigestRecord, 'provenance'>): string[] {
  const governed = governedSourcesOf(digest);
  return governed.length === 1 ? governed : [];
}

/**
 * A signal a MODEL wrote into a rule reading (RULE_AND_MODEL digests key them `m.<key>`). It restates the rule's
 * own facts from the same source, and it may name any combination of the supplied references -- so in a Situation
 * it would be a model choosing which entities belong together. Clustering reads the rule's observed facts only.
 */
function modelAuthored(digest: Pick<IntelligenceDigestRecord, 'provenance'>, key: unknown): boolean {
  return (digest.provenance as { producerKind?: unknown } | undefined)?.producerKind === 'RULE_AND_MODEL' && typeof key === 'string' && key.startsWith('m.');
}

/**
 * The ELIGIBLE digests' signals as clusterable inputs. A digest that is not legitimately current for
 * synthesis (digestSynthesisEligibility: status CURRENT, valid content, freshness SUFFICIENT or PARTIAL)
 * contributes nothing. A PARTIAL digest's signals carry its coverage and limitations. Each signal carries the
 * governed sources IT rests on (signalSourcesOf); a model's addition to a rule reading is left out.
 */
export function situationInputsOf(digests: readonly IntelligenceDigestRecord[], sources: ReadonlyMap<string, SynthesisSourceState>, now: Date): SituationSignalInput[] {
  const out: SituationSignalInput[] = [];
  for (const d of digests) {
    const eligibility = digestSynthesisEligibility(d, sources.get(d.id) ?? { connectionLive: false, sourceLastEvidenceAt: null }, now);
    if (!eligibility.eligible) continue;
    const lineage = signalSourcesOf(d);
    for (const s of d.content.signals ?? []) {
      if (modelAuthored(d, s.key)) continue;
      const key = String(s.key).replace(/[^A-Za-z0-9_.-]/g, '_');
      out.push({ ref: `digest:${d.id}/${key}`, domain: d.domain, signal: s, at: signalTime(s, d.generatedAt), coverage: eligibility.coverage, limitations: eligibility.limitations, sources: lineage });
    }
  }
  return out;
}

/** The context package and grounding evidence for one cluster (the SAME for synthesis and verification). */
export function situationContext(cluster: SituationClusterCandidate, open: readonly SituationView[], audience: 'ORGANIZATION' | 'PRINCIPAL', readUnder: { resource: string; action: 'view' }, organizationId: string) {
  const items: AiContextItem[] = cluster.items.map((item, i) => ({
    // Minted inside the organization (`<org>::`): the gateway refuses any other block before reserving.
    blockId: `${organizationId}::s${i}`,
    kind: 'STRUCTURED',
    trust: 'UNTRUSTED_INPUT',
    sourceRef: item.ref,
    content: JSON.stringify({
      part: item.domain,
      kind: item.signal.kind,
      knowledge: item.signal.knowledge,
      statement: item.signal.statement,
      severity: item.signal.severity ?? null,
      metric: item.signal.metric ?? null,
      records: item.signal.entities ?? [],
      when: new Date(item.at).toISOString().slice(0, 10),
      // The reading's coverage and what it could not see: synthesis must know a PARTIAL reading is partial.
      coverage: item.coverage ?? null,
      limitations: item.limitations ?? [],
    }),
    sensitivity: audience === 'PRINCIPAL' ? 'COMMUNICATION_CONTENT' : 'OPERATIONAL',
    readUnder,
  }));
  const figures = new Map<string, Set<number>>();
  const signalTimes = new Map<string, number>();
  const dates = new Set<string>();
  for (const item of cluster.items) {
    const set = figures.get(item.ref) ?? new Set<number>();
    for (const n of aiNumbersInText(item.signal.statement)) set.add(n);
    if (item.signal.metric) set.add(item.signal.metric.value);
    figures.set(item.ref, set);
    signalTimes.set(item.ref, item.at);
    dates.add(new Date(item.at).toISOString().slice(0, 10));
  }
  const clusterRefs = new Set(cluster.refs);
  const offered = open.filter((s) => s.record && s.record.refs.some((r) => clusterRefs.has(r))).slice(0, OFFERED_SITUATIONS);
  const evidence: SituationEvidence = {
    figures,
    dates,
    entityRefs: clusterRefs,
    signalTimes,
    clusterRefs,
    situations: new Map(offered.map((s) => [s.id, new Set(s.record!.refs)])),
  };
  return { items, evidence, offered };
}

function verificationState(verdicts: readonly { verdict: string }[], claims: number): SituationVerificationState {
  if (verdicts.length === 0 || claims === 0) return 'NOT_VERIFIED';
  const supported = verdicts.filter((v) => v.verdict === 'SUPPORTED').length;
  if (verdicts.some((v) => v.verdict === 'UNSUPPORTED')) return supported === 0 ? 'DISPUTED' : 'PARTIAL';
  return supported === claims ? 'VERIFIED' : 'PARTIAL';
}

/**
 * Why an owner's pass reached (or would reach) no synthesis call -- the first gate that stopped it, as a code:
 * NOT_MIGRATED, NOT_SELECTED (owners() would not visit it), NO_DIGESTS, NO_ELIGIBLE_DIGESTS,
 * INSUFFICIENT_DOMAINS (fewer than two eligible domains), NO_ELIGIBLE_SIGNALS (no signal of a situation kind
 * naming an entity), INSUFFICIENT_SIGNAL_DOMAINS (such signals in fewer than two domains), NO_SHARED_ENTITY
 * (no entity -- directly or through an explicit link -- appears in two domains), OUTSIDE_TEMPORAL_WINDOW
 * (shared, but too far apart in time), NO_INDEPENDENT_SOURCES (clusters exist, but none rests on two distinct
 * governed sources -- e.g. CallGrid + Campaigns alone), ALL_UNCHANGED (every independent cluster already decided
 * at this fingerprint), or WOULD_SYNTHESIZE (at least one independent cluster needs situation.synthesis, if it
 * is activated and a principal runs it).
 */
export type SituationDiagnosisReason =
  | 'NOT_MIGRATED'
  | 'NOT_SELECTED'
  | 'NO_DIGESTS'
  | 'NO_ELIGIBLE_DIGESTS'
  | 'INSUFFICIENT_DOMAINS'
  | 'NO_ELIGIBLE_SIGNALS'
  | 'INSUFFICIENT_SIGNAL_DOMAINS'
  | 'NO_SHARED_ENTITY'
  | 'OUTSIDE_TEMPORAL_WINDOW'
  | 'NO_INDEPENDENT_SOURCES'
  | 'ALL_UNCHANGED'
  | 'WOULD_SYNTHESIZE';

/** What an owner's situation pass sees, as counts and codes. Never a signal, an entity, a subject or an id. */
export interface SituationDiagnosis {
  readonly selected: boolean;
  readonly digests: number;
  readonly eligibleDigests: number;
  readonly eligibleDomains: readonly string[];
  /** Ineligible digests by eligibility reason (NOT_CURRENT_STATUS, REFRESH_UNRESOLVED, ...). */
  readonly ineligible: Readonly<Record<string, number>>;
  /** Per domain: digests, eligible, signals entering clustering, and those that can cluster. */
  readonly domains: readonly { readonly domain: string; readonly digests: number; readonly eligible: number; readonly signals: number; readonly clusterable: number; readonly entityRefs: number }[];
  /** Signals entering clusterSituationSignals. */
  readonly signals: number;
  /** Of those, of a situation kind AND naming at least one entity. */
  readonly clusterableSignals: number;
  /** Signals left out: by kind (not a situation kind), or naming no entity. */
  readonly excluded: { readonly kind: Readonly<Record<string, number>>; readonly noEntity: number };
  readonly clusterableDomains: readonly string[];
  /** Distinct canonical entity references the signals name. */
  readonly entityRefs: number;
  /** Explicit (persisted) entity links available between them. */
  readonly explicitLinks: number;
  /** Links projected from governed records for them (0 for a PRINCIPAL pass), and the projection by class. */
  readonly projectedLinks: number;
  readonly projection: readonly GovernedLinkClassCount[];
  /** Entity references named directly by clusterable signals in two or more domains (before links and the window). */
  readonly sharedAcrossDomains: number;
  readonly clusters: number;
  /** Of those, resting on at least two distinct governed sources -- the only ones synthesis may read. */
  readonly sourceIndependentClusters: number;
  /** Cross-domain clusters the independence rule removes (one source seen through several domains). */
  readonly eliminatedSameSource: number;
  /** Clusters by source composition: domains, governed sources, count, independent. Codes only. */
  readonly composition: readonly SourceComposition[];
  readonly unchanged: number;
  readonly wouldSynthesize: number;
  readonly reason: SituationDiagnosisReason;
}

export interface SourceComposition {
  readonly domains: readonly string[];
  readonly sources: readonly string[];
  readonly count: number;
  readonly sourceIndependent: boolean;
}

/** Cross-domain connectivity for one scenario, from the REAL clusterer (kind, window and sources applied). */
export interface ConnectivityScenario {
  readonly crossDomain: number;
  readonly sourceIndependent: number;
  readonly eliminatedSameSource: number;
  readonly composition: readonly SourceComposition[];
}

function compositionOf(clusters: readonly SituationClusterCandidate[]): ConnectivityScenario {
  const groups = new Map<string, SourceComposition>();
  for (const c of clusters) {
    const key = `${c.domains.join('+')}|${c.sources.join('+')}`;
    const g = groups.get(key);
    groups.set(key, { domains: c.domains, sources: c.sources, count: (g?.count ?? 0) + 1, sourceIndependent: c.sourceIndependent });
  }
  const independent = clusters.filter((c) => c.sourceIndependent).length;
  return {
    crossDomain: clusters.length,
    sourceIndependent: independent,
    eliminatedSameSource: clusters.length - independent,
    composition: [...groups.values()].sort((a, b) => b.count - a.count || a.domains.join().localeCompare(b.domains.join())),
  };
}

/**
 * What an organization can legitimately connect. The governed relationship classes over the WHOLE organization
 * (records, links they project, rejections by reason), CallGrid member identity and nameable records; and
 * cross-domain connectivity from the real clusterer over the pass's own eligible signals: CURRENT with persisted
 * entity_links only, PROJECTOR with the governed projection too (what the pass now uses) -- each with its
 * independent count and same-source eliminations.
 */
export interface SituationConnectivity {
  readonly governed: GovernedConnectivity;
  readonly relationships: readonly GovernedLinkClassCount[];
  readonly relationshipsBounded: boolean;
  readonly current: ConnectivityScenario;
  readonly projector: ConnectivityScenario;
}

export class SituationService {
  constructor(private readonly ports: SituationPorts) {}

  /**
   * The deterministic front half of a pass -- gather, eligibility, explicit links, clusters -- shared by
   * `pass` and `diagnose`, so the diagnosis is exactly what the pass sees. Reads only.
   */
  private async prepare(owner: SituationOwner, now: Date) {
    const digests = await this.gather(owner, now);
    const sources = await new DigestSourceStateRepository(this.ports.prisma).resolve(digests);
    const inputs = situationInputsOf(digests, sources, now);
    const linkOwner: EntityLinkOwner = owner.scope === 'ORGANIZATION' ? { scope: 'ORGANIZATION', organizationId: owner.organizationId } : { scope: 'PRINCIPAL', principal: { organizationId: owner.organizationId, userId: owner.userId } };
    const entities = [...new Set(inputs.flatMap((i) => i.signal.entities ?? []))];
    const links = entities.length ? await new EntityLinkRepository(this.ports.prisma).linksFor(linkOwner, entities) : [];
    // Governed projection: organization passes only (a private pass projects nothing into itself).
    const projection = owner.scope === 'ORGANIZATION' && entities.length ? await new GovernedEntityLinkProjector(this.ports.prisma).project(owner.organizationId, entities) : null;
    const explicitPairs = links.map((l) => [l.fromRef, l.toRef] as const);
    const projectedPairs = (projection?.links ?? []).map((l) => [l.fromRef, l.toRef] as const);
    const clusters = clusterSituationSignals(inputs, [...explicitPairs, ...projectedPairs]);
    return { digests, sources, inputs, entities, links, projection, explicitPairs, projectedPairs, clusters };
  }

  /**
   * READ-ONLY: what this organization could legitimately connect (SituationConnectivity). The domains' current
   * references come from the SAME prepare step as the pass (eligible digests, situation-kind signals naming an
   * entity); a domain's source is what its digest's provenance names. No model, no write, no link is created.
   */
  async connectivity(organizationId: string): Promise<SituationConnectivity> {
    const owner = { scope: 'ORGANIZATION', organizationId } as const;
    const now = this.ports.now();
    const { inputs, explicitPairs, projectedPairs } = await this.prepare(owner, now);
    const unlimited = { limit: Number.MAX_SAFE_INTEGER };
    const inventory = await new GovernedEntityLinkProjector(this.ports.prisma).project(organizationId, null);
    return {
      governed: await new SituationConnectivityRepository(this.ports.prisma).read(organizationId, now),
      relationships: inventory.classes,
      relationshipsBounded: inventory.bounded,
      current: compositionOf(clusterSituationSignals(inputs, explicitPairs, unlimited)),
      projector: compositionOf(clusterSituationSignals(inputs, [...explicitPairs, ...projectedPairs], unlimited)),
    };
  }

  /**
   * READ-ONLY DIAGNOSIS of one owner's pass: the same gather, eligibility, links and clusters as `pass`, and
   * which clusters are already decided -- then it stops. No model is called, nothing is written. Counts and
   * codes only.
   */
  async diagnose(owner: SituationOwner): Promise<SituationDiagnosis> {
    const situations = new SituationRepository(this.ports.prisma);
    const now = this.ports.now();
    const empty = { digests: 0, eligibleDigests: 0, eligibleDomains: [], ineligible: {}, domains: [], signals: 0, clusterableSignals: 0, excluded: { kind: {}, noEntity: 0 }, clusterableDomains: [], entityRefs: 0, explicitLinks: 0, projectedLinks: 0, projection: [], sharedAcrossDomains: 0, clusters: 0, sourceIndependentClusters: 0, eliminatedSameSource: 0, composition: [], unchanged: 0, wouldSynthesize: 0 };
    if (!(await situations.present())) return { selected: false, ...empty, reason: 'NOT_MIGRATED' };
    // The worker visits exactly these owners (the same bound it uses).
    const selected = (await situations.owners(owner.scope, now, 100)).some((o) => o.organizationId === owner.organizationId && (o.scope === 'ORGANIZATION' || (owner.scope === 'PRINCIPAL' && o.userId === owner.userId)));
    const { digests, sources, inputs, entities, links, projection, projectedPairs, clusters: allClusters } = await this.prepare(owner, now);
    // Diagnose every cluster the pass would see (the pass considers the first SITUATION_MAX_OPEN_CANDIDATES).
    const clusters = allClusters;

    const ineligible: Record<string, number> = {};
    const perDomain = new Map<string, { digests: number; eligible: number; signals: number; clusterable: number; refs: Set<string> }>();
    const domainOf = (d: string) => perDomain.get(d) ?? (perDomain.set(d, { digests: 0, eligible: 0, signals: 0, clusterable: 0, refs: new Set() }), perDomain.get(d)!);
    for (const d of digests) {
      const row = domainOf(d.domain);
      row.digests += 1;
      const e = digestSynthesisEligibility(d, sources.get(d.id) ?? { connectionLive: false, sourceLastEvidenceAt: null }, now);
      if (e.eligible) row.eligible += 1;
      else ineligible[e.reason] = (ineligible[e.reason] ?? 0) + 1;
    }
    const excludedKind: Record<string, number> = {};
    let noEntity = 0;
    const clusterable = inputs.filter((i) => {
      const row = domainOf(i.domain);
      row.signals += 1;
      const ofKind = SITUATION_SIGNAL_KINDS.includes(i.signal.kind);
      const named = (i.signal.entities?.length ?? 0) > 0;
      if (!ofKind) excludedKind[i.signal.kind] = (excludedKind[i.signal.kind] ?? 0) + 1;
      else if (!named) noEntity += 1;
      if (!ofKind || !named) return false;
      row.clusterable += 1;
      for (const e of i.signal.entities!) row.refs.add(e);
      return true;
    });
    const domainsOfRef = new Map<string, Set<string>>();
    for (const i of clusterable) for (const e of i.signal.entities!) domainsOfRef.set(e, (domainsOfRef.get(e) ?? new Set()).add(i.domain));
    const sharedAcrossDomains = [...domainsOfRef.values()].filter((d) => d.size >= 2).length;
    // The same join the clusterer makes: entities connected by explicit links count as one.
    const parent = new Map<string, string>();
    const root = (x: string): string => (parent.has(x) && parent.get(x) !== x ? root(parent.get(x)!) : x);
    for (const [from, to] of [...links.map((l) => [l.fromRef, l.toRef] as const), ...projectedPairs]) {
      const [a, b] = [root(from), root(to)];
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
    const domainsOfRoot = new Map<string, Set<string>>();
    for (const [e, ds] of domainsOfRef) domainsOfRoot.set(root(e), new Set([...(domainsOfRoot.get(root(e)) ?? []), ...ds]));
    const sharedViaLinks = [...domainsOfRoot.values()].some((d) => d.size >= 2);

    // Only an independent cluster can reach synthesis; "unchanged" is judged among those.
    const independent = clusters.filter((c) => c.sourceIndependent);
    let unchanged = 0;
    for (const cluster of independent) {
      const stored = await situations.candidate(owner, `sc_${sha(cluster.clusterBasis).slice(0, 32)}`);
      if (stored?.fingerprint === `situation:${sha(cluster.fingerprintBasis)}`) unchanged += 1;
    }
    const composed = compositionOf(clusters);
    const eligibleDomains = [...perDomain.entries()].filter(([, r]) => r.eligible > 0).map(([d]) => d).sort();
    const clusterableDomains = [...new Set(clusterable.map((i) => i.domain))].sort();
    const reason: SituationDiagnosisReason = !selected
      ? 'NOT_SELECTED'
      : digests.length === 0
        ? 'NO_DIGESTS'
        : eligibleDomains.length === 0
          ? 'NO_ELIGIBLE_DIGESTS'
          : eligibleDomains.length < 2
            ? 'INSUFFICIENT_DOMAINS'
            : clusterable.length === 0
              ? 'NO_ELIGIBLE_SIGNALS'
              : clusterableDomains.length < 2
                ? 'INSUFFICIENT_SIGNAL_DOMAINS'
                : clusters.length === 0
                  ? sharedViaLinks
                    ? 'OUTSIDE_TEMPORAL_WINDOW'
                    : 'NO_SHARED_ENTITY'
                  : independent.length === 0
                    ? 'NO_INDEPENDENT_SOURCES'
                    : unchanged === independent.length
                      ? 'ALL_UNCHANGED'
                      : 'WOULD_SYNTHESIZE';
    return {
      selected,
      digests: digests.length,
      eligibleDigests: [...perDomain.values()].reduce((n, r) => n + r.eligible, 0),
      eligibleDomains,
      ineligible,
      domains: [...perDomain.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([domain, r]) => ({ domain, digests: r.digests, eligible: r.eligible, signals: r.signals, clusterable: r.clusterable, entityRefs: r.refs.size })),
      signals: inputs.length,
      clusterableSignals: clusterable.length,
      excluded: { kind: excludedKind, noEntity },
      clusterableDomains,
      entityRefs: entities.length,
      explicitLinks: links.length,
      projectedLinks: projectedPairs.length,
      projection: projection?.classes ?? [],
      sharedAcrossDomains,
      clusters: clusters.length,
      sourceIndependentClusters: independent.length,
      eliminatedSameSource: composed.eliminatedSameSource,
      composition: composed.composition,
      unchanged,
      wouldSynthesize: independent.length - unchanged,
      reason,
    };
  }

  private async gather(owner: SituationOwner, now: Date): Promise<IntelligenceDigestRecord[]> {
    const digests = new IntelligenceDigestRepository(this.ports.prisma);
    if (owner.scope === 'ORGANIZATION') {
      const all = await Promise.all(ORGANIZATION_DOMAINS.map((d) => digests.organizationForDomain(owner.organizationId, d, { now, limit: DIGESTS_PER_DOMAIN })));
      return all.flat();
    }
    const principal = { organizationId: owner.organizationId, userId: owner.userId };
    const all = await Promise.all(PERSONAL_DOMAINS.map((d) => digests.forDomain(principal, d, { now, limit: DIGESTS_PER_DOMAIN })));
    return all.flat();
  }

  async pass(owner: SituationOwner): Promise<SituationPassReport> {
    const situations = new SituationRepository(this.ports.prisma);
    const report = { candidates: 0, sameSourceOnly: 0, unchanged: 0, notAsked: 0, decisions: {} as Record<string, number>, verification: {} as Record<string, number>, refused: {} as Record<string, number> };
    const tally = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
    if (!(await situations.present())) return { state: 'NOT_MIGRATED', ...report };
    const now = this.ports.now();
    const { clusters } = await this.prepare(owner, now);
    report.candidates = clusters.length;
    if (clusters.length === 0) return { state: 'RAN', ...report };
    // INDEPENDENCE: only a cluster resting on two distinct governed sources is read -- before any lookup or call.
    const independent = clusters.filter((c) => c.sourceIndependent);
    report.sameSourceOnly = clusters.length - independent.length;
    if (independent.length === 0) return { state: 'RAN', ...report };

    const synthTask = owner.scope === 'ORGANIZATION' ? AI_TASK_SITUATION_SYNTHESIS : AI_TASK_PRIVATE_SITUATION_SYNTHESIS;
    const verifyTask = owner.scope === 'ORGANIZATION' ? AI_TASK_SITUATION_VERIFICATION : AI_TASK_PRIVATE_SITUATION_VERIFICATION;
    const open = await situations.open(owner, 20);
    for (const cluster of independent) {
      const clusterKey = `sc_${sha(cluster.clusterBasis).slice(0, 32)}`;
      const fingerprint = `situation:${sha(cluster.fingerprintBasis)}`;
      const stored = await situations.candidate(owner, clusterKey);
      if (stored?.fingerprint === fingerprint) {
        report.unchanged += 1;
        continue;
      }
      if (!this.ports.runtime || !this.ports.modelEnabled(synthTask.taskId)) {
        report.notAsked += 1;
        continue;
      }
      const principal = await this.ports.principalFor(owner);
      if (!principal) {
        report.notAsked += 1;
        continue;
      }
      const { items, evidence, offered } = situationContext(cluster, open, owner.scope, synthTask.requires[0]!, owner.organizationId);
      const context = { organizationId: owner.organizationId, viewerUserId: principal.userId, taskId: synthTask.taskId, items, sensitivityCeiling: synthTask.sensitivityCeiling };
      const synth = await this.ports.runtime.run(principal, {
        task: synthTask,
        context,
        instructions: renderSituationSynthesisInstructions(owner.scope, items.map((i) => i.sourceRef), offered.map((s) => s.id)),
        templateId: SITUATION_SYNTHESIS_TEMPLATE_ID,
        templateVersion: SITUATION_TEMPLATE_VERSION,
        schema: SITUATION_SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
        evidence,
      });
      if (synth.outcome !== 'ANSWERED' || !synth.output.situationSynthesis) {
        const code = synth.outcome === 'REFUSED_BY_LOOP' ? `LOOP:${synth.refusals[0] ?? 'REFUSED'}` : synth.outcome;
        tally(report.refused, code);
        // An answer the contract rejected would be rejected again for the same input: remember it, so an
        // unchanged cluster is not paid for twice. A refusal before any call (budget, policy) is retried.
        if (synth.outcome === 'REJECTED_OUTPUT') await situations.recordCandidate(owner, { clusterKey, fingerprint, decision: 'NONE', caseId: null, verification: 'REJECTED_OUTPUT', at: now });
        continue;
      }
      const s: AiSituationSynthesis = synth.output.situationSynthesis;
      tally(report.decisions, s.decision);
      if (s.decision === 'NONE') {
        await situations.recordCandidate(owner, { clusterKey, fingerprint, decision: 'NONE', caseId: null, verification: null, at: now });
        continue;
      }
      // Independent VERIFICATION: a DIFFERENT model provider, or honestly none (UNAVAILABLE). Unrelated to source
      // independence, which this cluster already passed: a situation on two governed sources is recorded even
      // when no second provider exists.
      const subjectProvider = synth.provenance.requestedModel.providerId;
      let state: SituationVerificationState = 'UNAVAILABLE';
      let verifier: string | null = null;
      let verdicts: readonly { claimIndex: number; verdict: 'SUPPORTED' | 'UNSUPPORTED' | 'UNCLEAR' }[] = [];
      if (this.ports.modelEnabled(verifyTask.taskId)) {
        const check = await this.ports.runtime.run(principal, {
          task: verifyTask,
          context: { ...context, taskId: verifyTask.taskId, sensitivityCeiling: verifyTask.sensitivityCeiling },
          instructions: renderSituationVerificationInstructions(s.claims),
          templateId: SITUATION_VERIFICATION_TEMPLATE_ID,
          templateVersion: SITUATION_TEMPLATE_VERSION,
          schema: SITUATION_VERIFICATION_SCHEMA as unknown as Record<string, unknown>,
          evidence: { ...evidence, claimCount: s.claims.length } as SituationEvidence,
          subjectProvider,
        });
        if (check.outcome === 'ANSWERED' && check.output.situationVerification) {
          verdicts = check.output.situationVerification.verdicts;
          state = verificationState(verdicts, s.claims.length);
          verifier = check.provenance.requestedModel.providerId;
        } else if (check.outcome === 'REFUSED_BY_LOOP' && check.refusals.some((r) => r === 'NO_INDEPENDENT_PROVIDER' || r === 'PROVIDER_NOT_ENABLED' || r === 'PROVIDER_NOT_REGISTERED')) {
          state = 'UNAVAILABLE';
        } else {
          state = 'NOT_VERIFIED';
        }
      }
      tally(report.verification, state);
      if (state === 'DISPUTED') {
        // An independent reader found no claim supported: nothing is shown as a situation.
        await situations.recordCandidate(owner, { clusterKey, fingerprint, decision: 'NONE', caseId: null, verification: state, at: now });
        continue;
      }
      const record: SituationRecord = {
        schema: SITUATION_RECORD_SCHEMA,
        clusterKey,
        fingerprint,
        narrative: s.narrative ?? '',
        refs: cluster.refs,
        citations: [...new Set(s.claims.flatMap((c) => c.citations))],
        domains: cluster.domains,
        claims: s.claims.map((c, i) => ({ kind: c.kind, statement: c.statement, citations: c.citations, verdict: verdicts.find((v) => v.claimIndex === i)?.verdict ?? null })),
        // The model's own limitations AND every partial reading's: a limitation is never lost on the way up.
        limitations: [...new Set([...s.limitations, ...cluster.items.flatMap((i) => i.limitations ?? [])])].slice(0, 8),
        verification: { state, providerId: verifier },
        synthesis: { invocationId: synth.provenance.invocationId, providerId: subjectProvider, taskId: synthTask.taskId, taskVersion: synth.provenance.taskVersion },
        windowStart: new Date(cluster.windowStart).toISOString(),
        windowEnd: new Date(cluster.windowEnd).toISOString(),
      };
      const top = Math.max(...cluster.items.map((i) => SEVERITY[i.signal.severity ?? ''] ?? 1));
      const written = await situations.record(owner, { decision: s.decision, caseId: s.situationId, title: s.title ?? '', narrative: s.narrative ?? '', severity: top >= 3 ? 'HIGH' : top === 2 ? 'MEDIUM' : 'LOW', record, at: now });
      if (written.outcome === 'REFUSED') {
        tally(report.refused, written.refusal);
        continue;
      }
      await situations.recordCandidate(owner, { clusterKey, fingerprint, decision: s.decision, caseId: written.caseId, verification: state, at: now });
    }
    return { state: 'RAN', ...report };
  }
}
