// Assembling one investigation for a product surface. READ ONLY.
//
// WHAT THIS IS. The single read that answers "what is this Case, why does it
// exist, what does Loop know, and what does it not". It reads the Decision Center
// thread, its evidence and its log, re-reads the Headline that opened it, derives
// the investigative organization of what is already there, and returns one
// product-shaped view.
//
// IT WRITES NOTHING, AND CANNOT. Every seam it holds is a read: the engine's
// `get`, the Headline repository's `get`. There is no create, no append, no
// update and no transaction anywhere in this file, so "the brief does not mutate
// the Case" is a property of the shape rather than of somebody's care.
//
// NOTHING IS CACHED. The brief is recomputed on every read. A cached projection
// of an append-only log is a second copy that can be wrong, and the log is cheap:
// an investigation has tens of observations, not thousands.
//
// NO FINDING, NO RECOMMENDATION, NO NARRATIVE, NO MODEL. A Case may already carry
// a linked `IntelligenceHypothesis` from a producer that opened one -- it is
// deliberately not exposed here. Surfacing a belief through a Case Brief would
// give it Stage 4 Finding semantics a PR early, and a hypothesis a producer wrote
// is not something a person authorized an investigation into.
//
// LINEAGE IS RE-READ, NEVER TRUSTED. The Case stores a Headline id and nothing
// else about it. This service resolves that id through the Headline's own
// organization-scoped read, every time. A Headline the caller cannot legitimately
// reach comes back null with a stated reason, so a Case can never become a way to
// see one.

import type { PrismaClient } from '@prisma/client';
import {
  projectEvidenceContext,
  isEvidenceClass,
  isMeasuredEvidence,
  reportedLine,
  CASE_PARTY_ENTITY_TYPES,
  CASE_PLACE_ENTITY_TYPES,
  CASE_WHY_UNAVAILABLE,
  INVESTIGATION_PRODUCER,
  isInvestigationAuthorization,
  type CaseBriefView,
  type CaseDimensionItem,
  type CaseEvidenceItem,
  type ContextObservation,
  type EvidenceContextEntry,
  type CaseFiveWs,
  type CaseOrigin,
  type CaseTimelineEntry,
  type CaseUncertainty,
  type HeadlineView,
  type ObservationType,
  type PriorityState,
} from '@emgloop/shared';

import { HeadlineRepository } from '../repositories/headline.repository';
import { DecisionEngine } from './decision/decision-engine';

/** The Decision Center read this service needs. One method, and it is a read. */
export type CaseReader = Pick<DecisionEngine, 'get'>;

/** The Headline read used for lineage. Organization-scoped, fails closed to null. */
export interface CaseHeadlineReader {
  get(organizationId: string, id: string): Promise<HeadlineView | null>;
}

export interface CaseBriefDeps {
  cases?: CaseReader;
  headlines?: CaseHeadlineReader;
}

const PARTY_TYPES: ReadonlySet<string> = new Set(CASE_PARTY_ENTITY_TYPES);
const PLACE_TYPES: ReadonlySet<string> = new Set(CASE_PLACE_ENTITY_TYPES);

/** Said once, so every unresolved lineage reads the same way. */
const HEADLINE_UNRESOLVED =
  'The originating headline could not be read in this organization. It may have been ' +
  'removed, or it may not be visible here.';

export class CaseBriefService {
  private readonly cases: CaseReader;
  private readonly headlines: CaseHeadlineReader;

  constructor(prisma: PrismaClient, deps: CaseBriefDeps = {}) {
    this.cases = deps.cases ?? new DecisionEngine(prisma);
    this.headlines = deps.headlines ?? new HeadlineRepository(prisma);
  }

  /**
   * One investigation, assembled.
   *
   * NOT-FOUND, NEVER FORBIDDEN. A Case belonging to another organization resolves
   * to null exactly as a Case that does not exist, so the answer cannot be used
   * to discover that other tenants hold one.
   */
  async get(organizationId: string, caseId: string): Promise<CaseBriefView | null> {
    if (!caseId?.trim()) return null;
    const view = await this.cases.get(organizationId, caseId.trim());
    if (!view) return null;

    const decision = view.decision;
    // CONTEXT COMES OFF THE CASE'S OWN LOG, not a second store. The relations
    // were recorded as observations, so projecting them is a replay of what this
    // read already has in hand.
    const context = projectEvidenceContext(view.observations.map(toContextObservation));
    const evidence = view.evidence.map((e) => toEvidenceItem(e, context.get(e.id) ?? []));
    const timeline = view.observations.map(toTimelineEntry);

    return {
      caseId: decision.id,
      status: view.currentState as PriorityState,
      title: decision.title,
      subject: decision.summary,
      origin: await this.resolveOrigin(organizationId, decision),
      authorization: resolveAuthorization(timeline),
      ownerUserId: view.ownerUserId,
      assigneeUserId: view.assigneeUserId,
      evidence,
      uncertainty: summarizeUncertainty(evidence),
      fiveWs: deriveFiveWs(evidence, timeline, decision.title),
      timeline,
      history: view.history,
      outcome: decision.outcome ?? null,
      measuredEffectCents: decision.measuredEffectCents ?? null,
      sourceSystem: decision.sourceSystem,
      recurrenceKey: decision.recurrenceKey,
    };
  }

  /**
   * Where this investigation came from.
   *
   * THE PRODUCER IS CHECKED BEFORE THE REFERENCE IS TRUSTED. `sourceReference` is
   * documented as an opaque producer handle the platform never parses -- a
   * CallGrid thread's reference is a call id, not a Headline id, and reading it as
   * one would send a lineage query somewhere meaningless. Only a thread opened by
   * the investigation producer has a Headline behind that field.
   */
  private async resolveOrigin(
    organizationId: string,
    decision: { sourceSystem: string; sourceReference: string | null },
  ): Promise<CaseOrigin> {
    if (decision.sourceSystem !== INVESTIGATION_PRODUCER || !decision.sourceReference) {
      return {
        kind: 'PRODUCER',
        sourceSystem: decision.sourceSystem,
        sourceReference: decision.sourceReference,
      };
    }

    const headlineId = decision.sourceReference;
    // RE-READ THROUGH THE HEADLINE'S OWN ORGANIZATION-SCOPED READ. This is the
    // leak boundary: the Case names an id, and only the Headline repository
    // decides whether this organization may have it.
    const headline = await this.headlines.get(organizationId, headlineId);
    if (!headline) {
      return { kind: 'HEADLINE', headlineId, headline: null, unresolvedReason: HEADLINE_UNRESOLVED };
    }
    return {
      kind: 'HEADLINE',
      headlineId,
      unresolvedReason: null,
      headline: {
        headlineId: headline.id,
        statement: headline.statement,
        performanceObjectiveId: headline.performanceObjectiveId,
        objectiveTitle: headline.objectiveTitle,
        metric: headline.measurement.metric,
        metricLabel: headline.measurement.metricLabel,
        againstObjective: headline.measurement.againstObjective,
        currentValue: headline.measurement.currentValue,
        priorValue: headline.measurement.priorValue,
        percentageChange: headline.measurement.percentageChange,
        currentCoverage: headline.measurement.currentCoverage,
        comparisonBasis: headline.measurement.comparisonBasis,
        currentWindowStart: headline.measurement.currentWindowStart,
        currentWindowEnd: headline.measurement.currentWindowEnd,
        dismissedAt: headline.dismissedAt,
      },
    };
  }
}

// --- Projections ------------------------------------------------------------------

function toEvidenceItem(e: {
  id: string;
  source: string;
  evidenceClass: string;
  statement: string | null;
  reportedByUserId: string | null;
  metricKey: string | null;
  window: string | null;
  derivedValue: number | null;
  completeness: number | null;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
  limitations: string[];
  unknowns: string[];
  ruleId: string | null;
  ruleVersion: string | null;
  producerVersion: string | null;
  observedAt: Date;
}, context: readonly EvidenceContextEntry[] = []): CaseEvidenceItem {
  return {
    id: e.id,
    source: e.source,
    // THE STORED VALUE, OR A REFUSAL TO GUESS. A row carrying a class this build
    // does not know is reported as what it is rather than defaulted into MEASURED,
    // because defaulting would let an unrecognised row through the measurement
    // gate.
    evidenceClass: isEvidenceClass(e.evidenceClass) ? e.evidenceClass : 'HUMAN_REPORTED',
    statement: e.statement,
    reportedByUserId: e.reportedByUserId,
    metricKey: e.metricKey,
    window: e.window,
    value: e.derivedValue,
    completeness: e.completeness,
    entityType: e.entityType,
    entityId: e.entityId,
    entityName: e.entityName,
    limitations: e.limitations,
    unknowns: e.unknowns,
    ruleId: e.ruleId,
    ruleVersion: e.ruleVersion,
    producerVersion: e.producerVersion,
    observedAt: e.observedAt.toISOString(),
    context,
  };
}

/** One observation, in the plain values the context projection reads. */
function toContextObservation(o: {
  id: string;
  observationType: string;
  evidenceId: string | null;
  relatedEvidenceId: string | null;
  evidenceRelation: string | null;
  note: string | null;
  actorType: string;
  actorUserId: string | null;
  source: string;
  occurredAt: Date;
  recordedAt: Date;
}): ContextObservation {
  return {
    id: o.id,
    observationType: o.observationType,
    evidenceId: o.evidenceId,
    relatedEvidenceId: o.relatedEvidenceId,
    evidenceRelation: o.evidenceRelation,
    note: o.note,
    actorType: o.actorType,
    actorUserId: o.actorUserId,
    source: o.source,
    occurredAt: o.occurredAt.toISOString(),
    recordedAt: o.recordedAt.toISOString(),
  };
}

/**
 * How one piece of evidence reads under WHAT.
 *
 * ATTRIBUTION IS PART OF THE LABEL for a report, and the whole label for a
 * measurement is the measure it names. Neither borrows the other's shape: a
 * report with no measure is not "unknown metric", and a measurement is not
 * something somebody said.
 */
function labelForEvidence(e: CaseEvidenceItem): string {
  if (!isMeasuredEvidence(e)) {
    const said = e.statement ?? '';
    return `${reportedLine(e.reportedByUserId)}: "${said}"`;
  }
  const measure = e.metricKey ?? 'a measure it does not name';
  return e.window ? `${measure} (${e.window})` : measure;
}

function toTimelineEntry(o: {
  id: string;
  sequence: number;
  observationType: string;
  occurredAt: Date;
  recordedAt: Date;
  actorType: string;
  actorUserId: string | null;
  source: string;
  reason: string | null;
  note: string | null;
  previousState: string | null;
  newState: string | null;
  outcome: string | null;
}): CaseTimelineEntry {
  return {
    id: o.id,
    sequence: o.sequence,
    type: o.observationType as ObservationType,
    occurredAt: o.occurredAt.toISOString(),
    recordedAt: o.recordedAt.toISOString(),
    actorType: o.actorType === 'HUMAN' ? 'HUMAN' : 'SYSTEM',
    actorUserId: o.actorUserId,
    source: o.source,
    reason: o.reason,
    note: o.note,
    previousState: (o.previousState as PriorityState | null) ?? null,
    newState: (o.newState as PriorityState | null) ?? null,
    outcome: (o.outcome as CaseTimelineEntry['outcome']) ?? null,
  };
}

/**
 * Who authorized this investigation, and when.
 *
 * THE EARLIEST MATCH WINS. An investigation is authorized once; later rows on the
 * same thread are somebody reading it again, and taking the newest would make the
 * answer drift every time a person opened the page.
 *
 * The match itself is the shared predicate, so this and the promotion cannot come
 * to different conclusions about the same row.
 */
function resolveAuthorization(timeline: CaseTimelineEntry[]): CaseBriefView['authorization'] {
  const match = [...timeline]
    .sort((a, b) => a.sequence - b.sequence)
    .find((o) =>
      // The brief renames the field to `type` for a product surface; the shared
      // predicate speaks the log's own vocabulary. Adapted here rather than
      // loosening the predicate, so the one place that decides what an
      // authorization is keeps naming the columns it actually reads.
      isInvestigationAuthorization({
        actorType: o.actorType,
        observationType: o.type,
        reason: o.reason,
      }),
    );
  if (!match || !match.actorUserId) return null;
  return {
    userId: match.actorUserId,
    at: match.occurredAt,
    recordedAt: match.recordedAt,
    note: match.note,
  };
}

/**
 * What the investigation does not know, in the three shapes it can distinguish.
 *
 * DEDUPED, ORDER PRESERVED. The same caveat attached to three pieces of evidence
 * is one caveat a person has to weigh, and repeating it makes a brief read as
 * though the doubt compounds.
 */
function summarizeUncertainty(evidence: CaseEvidenceItem[]): CaseUncertainty {
  const limitations: string[] = [];
  const unknowns: string[] = [];
  let incomplete = 0;
  let unstated = 0;
  for (const e of evidence) {
    for (const l of e.limitations) if (!limitations.includes(l)) limitations.push(l);
    for (const u of e.unknowns) if (!unknowns.includes(u)) unknowns.push(u);
    // NULL IS NOT ONE. "The producer did not say" and "all of it reported" are
    // different facts and are counted separately.
    // MEASUREMENT COUNTS, OVER MEASUREMENTS ONLY. Completeness means "this
    // fraction of the population reported", which a human report does not have
    // and cannot lack: counting a report as "completeness unstated" would file a
    // person's sentence as a gap in Loop's instrumentation.
    if (!isMeasuredEvidence(e)) continue;
    if (e.completeness === null) unstated += 1;
    else if (e.completeness < 1) incomplete += 1;
  }
  return {
    limitations,
    unknowns,
    incompleteEvidenceCount: incomplete,
    completenessUnstatedCount: unstated,
  };
}

/**
 * The investigative organization of what is already known.
 *
 * FOUR DETERMINISTIC RULES AND ONE DELIBERATE EMPTINESS:
 *
 *   WHO    distinct humans on the log, plus evidence entities whose type is in the
 *          closed party list.
 *   WHAT   one item per evidence row: the measured fact.
 *   WHEN   the case's own detection instants and each evidence row's observation
 *          time and stated window.
 *   WHERE  evidence entities whose type is in the closed place list.
 *   WHY    empty. Nothing recorded today marks evidence as relevant to
 *          explanation, and filling this from the nearest available number would
 *          be inferring a cause.
 *
 * AN ENTITY TYPE IN NEITHER LIST IS NOT GUESSED INTO A DIMENSION. It stays in
 * WHAT, attached to the measurement it belongs to, because a `headline` entity is
 * neither a party nor a place and pretending otherwise would put the wrong noun
 * under a heading a person is about to reason from.
 */
function deriveFiveWs(
  evidence: CaseEvidenceItem[],
  timeline: CaseTimelineEntry[],
  title: string,
): CaseFiveWs {
  const who: CaseDimensionItem[] = [];
  const what: CaseDimensionItem[] = [];
  const when: CaseDimensionItem[] = [];
  const where: CaseDimensionItem[] = [];
  const seen = new Set<string>();
  const push = (into: CaseDimensionItem[], item: CaseDimensionItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    into.push(item);
  };

  // WHO — the people, from the log. Ordered by first appearance, so the person who
  // authorized it leads rather than whoever touched it most recently.
  for (const o of [...timeline].sort((a, b) => a.sequence - b.sequence)) {
    if (o.actorType !== 'HUMAN' || !o.actorUserId) continue;
    push(who, {
      key: `user:${o.actorUserId}`,
      label: o.actorUserId,
      derivedFrom: 'TIMELINE',
      evidenceId: null,
    });
  }

  for (const e of evidence) {
    // WHAT — the measured fact, or the reported sentence, ATTRIBUTED.
    //
    // A REPORT IS NEVER PLACED AS A BARE STATEMENT. "The API token expired" and
    // "Matt reported that the API token expired" are different claims, and only
    // the second is established the moment it is written. PR 6 owns the epistemic
    // tagging of the 5Ws; this is only what it takes to place a report here
    // without the placement asserting it is true.
    push(what, {
      key: `evidence:${e.id}`,
      label: labelForEvidence(e),
      derivedFrom: 'EVIDENCE',
      evidenceId: e.id,
    });

    // WHEN — when the evidence describes the world, and the period it names.
    push(when, {
      key: `observed:${e.id}`,
      label: e.observedAt,
      derivedFrom: 'EVIDENCE',
      evidenceId: e.id,
    });
    if (e.window) {
      push(when, { key: `window:${e.window}`, label: e.window, derivedFrom: 'EVIDENCE', evidenceId: e.id });
    }

    // WHO / WHERE — only for an entity type the closed lists recognise.
    if (e.entityType && e.entityId) {
      const label = e.entityName ?? `${e.entityType} ${e.entityId}`;
      const key = `${e.entityType}:${e.entityId}`;
      if (PARTY_TYPES.has(e.entityType)) {
        push(who, { key, label, derivedFrom: 'EVIDENCE', evidenceId: e.id });
      } else if (PLACE_TYPES.has(e.entityType)) {
        push(where, { key, label, derivedFrom: 'EVIDENCE', evidenceId: e.id });
      }
    }
  }

  // WHAT also carries the claim itself when there is no evidence at all, so a
  // brief on a thread nobody has attached evidence to is not blank.
  if (what.length === 0) {
    push(what, { key: 'claim', label: title, derivedFrom: 'CASE', evidenceId: null });
  }

  const unavailable: CaseFiveWs['unavailable'] = { WHY: CASE_WHY_UNAVAILABLE };
  if (who.length === 0) unavailable.WHO = 'Nobody is recorded on this investigation yet.';
  if (where.length === 0) {
    unavailable.WHERE =
      'No evidence names a campaign, market, channel or system this condition exists in.';
  }
  if (when.length === 0) unavailable.WHEN = 'No evidence states when it describes the world.';

  return { who, what, when, where, why: [], unavailable };
}
