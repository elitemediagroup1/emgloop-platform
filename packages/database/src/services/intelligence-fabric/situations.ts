// Situation synthesis: connected business situations across domains, held as Cases. Loop Intelligence
// Phase F, 2026-09-26.
//
//   gather     the owner's CURRENT digests -- the organization's readings for an ORGANIZATION pass; the
//              person's own (Chats, Mail, Calendar, their Work) for a PRINCIPAL pass -- and the explicit
//              entity links the owner may see. Loop's own artifacts only; no source is read.
//   cluster    deterministically (clusterSituationSignals): shared canonical entities or explicit links,
//              within the temporal window, across at least two domains. No model decides what to look at.
//   skip       a cluster whose fingerprint equals the last decided one costs nothing (situation_candidates).
//   synthesize situation.synthesis[.private]: NEW / UPDATE (a SUPPLIED open situation) / NONE, with claims
//              citing supplied signal refs -- validated by the registered contract before this sees it.
//   verify     situation.verify[.private], routed OTHER_THAN_SUBJECT: a different provider marks each claim.
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
  SITUATION_SYNTHESIS_SCHEMA,
  SITUATION_VERIFICATION_SCHEMA,
  aiNumbersInText,
  clusterSituationSignals,
  type AiContextItem,
  type AiSituationSynthesis,
  type IntelligenceDomain,
  type SituationClusterCandidate,
  type SituationEvidence,
  type SituationSignalInput,
  type SituationVerificationState,
} from '@emgloop/shared';

import { EntityLinkRepository, type EntityLinkOwner } from '../../repositories/intelligence/entity-link.repository';
import { IntelligenceDigestRepository, type IntelligenceDigestRecord } from '../../repositories/intelligence/intelligence-digest.repository';
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

/** One digest's signals as clusterable inputs. */
export function situationInputsOf(digests: readonly IntelligenceDigestRecord[]): SituationSignalInput[] {
  const out: SituationSignalInput[] = [];
  for (const d of digests) {
    for (const s of d.content.signals ?? []) {
      const key = String(s.key).replace(/[^A-Za-z0-9_.-]/g, '_');
      out.push({ ref: `digest:${d.id}/${key}`, domain: d.domain, signal: s, at: signalTime(s, d.generatedAt) });
    }
  }
  return out;
}

/** The context package and grounding evidence for one cluster (the SAME for synthesis and verification). */
export function situationContext(cluster: SituationClusterCandidate, open: readonly SituationView[], audience: 'ORGANIZATION' | 'PRINCIPAL', readUnder: { resource: string; action: 'view' }) {
  const items: AiContextItem[] = cluster.items.map((item, i) => ({
    blockId: `s${i}`,
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

export class SituationService {
  constructor(private readonly ports: SituationPorts) {}

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
    const report = { candidates: 0, unchanged: 0, notAsked: 0, decisions: {} as Record<string, number>, verification: {} as Record<string, number>, refused: {} as Record<string, number> };
    const tally = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
    if (!(await situations.present())) return { state: 'NOT_MIGRATED', ...report };
    const now = this.ports.now();
    const inputs = situationInputsOf(await this.gather(owner, now));
    const linkOwner: EntityLinkOwner = owner.scope === 'ORGANIZATION' ? { scope: 'ORGANIZATION', organizationId: owner.organizationId } : { scope: 'PRINCIPAL', principal: { organizationId: owner.organizationId, userId: owner.userId } };
    const entities = [...new Set(inputs.flatMap((i) => i.signal.entities ?? []))];
    const links = entities.length ? await new EntityLinkRepository(this.ports.prisma).linksFor(linkOwner, entities) : [];
    const clusters = clusterSituationSignals(inputs, links.map((l) => [l.fromRef, l.toRef] as const));
    report.candidates = clusters.length;
    if (clusters.length === 0) return { state: 'RAN', ...report };

    const synthTask = owner.scope === 'ORGANIZATION' ? AI_TASK_SITUATION_SYNTHESIS : AI_TASK_PRIVATE_SITUATION_SYNTHESIS;
    const verifyTask = owner.scope === 'ORGANIZATION' ? AI_TASK_SITUATION_VERIFICATION : AI_TASK_PRIVATE_SITUATION_VERIFICATION;
    const open = await situations.open(owner, 20);
    for (const cluster of clusters) {
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
      const { items, evidence, offered } = situationContext(cluster, open, owner.scope, synthTask.requires[0]!);
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
      // Independent verification: a DIFFERENT provider, or honestly none.
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
        limitations: s.limitations,
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
