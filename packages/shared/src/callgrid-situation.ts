// The Situation — the atom of the operational review system.
//
// Everything before this module ranked FINDINGS. A finding is one rule fired
// against one metric over one window, so a single business event arrives as
// several of them: revenue fell, a buyer contributed most of the fall, that
// buyer left the top five, concentration rose. Ranking those independently
// produces a ranked list of SYMPTOMS, and the operator is left to work out that
// they are one thing. That synthesis is the product's job, not theirs.
//
// So the order is inverted here. Findings are MERGED into clusters first
// (`clusterFindings`, which unions them over measured relations only), and the
// cluster is what competes for attention. One business event, one queue row,
// one owner, one decision.
//
// THE MERGE IS THE DANGEROUS PART, and three rules constrain it:
//
//   1. A Situation always discloses how many observations it merged, so a merge
//      is never invisible.
//   2. Its observations remain individually available, so a merge is always
//      reversible by the reader.
//   3. Only MEASURED relations merge. Co-occurrence in the same period is not a
//      ground — two unrelated problems on one Tuesday are two problems, and
//      merging them would invent a business event that did not happen.
//
// Five cards for one event is annoying. One card for two events hides a real
// problem, which is worse, so under-merging is the safe direction and this
// module never widens a cluster beyond what `relate` established.
//
// Pure. No I/O, no clock, no RNG — `now` and every label arrive from the caller.

import type { CallGridFinding, IntelligenceUnknown, Severity } from './callgrid-intelligence';
import { SEVERITY_RANK } from './callgrid-intelligence';
import type { ReasoningCluster, ReasoningRelation, OperationalReasoning } from './callgrid-reasoning';
import type { ScoredFinding, IntelligenceScore } from './callgrid-scoring';
import { recurrenceKey } from './callgrid-scoring';
import type { DecisionSupportCard, BusinessImpact, ReviewUrgency } from './callgrid-decision-support';
import { REVIEW_URGENCY_RANK } from './callgrid-decision-support';
import type { Opportunity } from './callgrid-opportunity';

export const SITUATION_VERSION = 'v1';

// --- Queue state ----------------------------------------------------------------
//
// The operator's workflow, not the engine's. These are the lanes of the queue.
//
// Only NEEDS_REVIEW is reachable today: every other lane is a state an operator
// PUT something into, and nothing yet stores that. `laneAvailability` below says
// so out loud rather than rendering four lanes that can never fill — a lane that
// is permanently empty for an unstated reason reads as a broken product.

export const QUEUE_STATES = [
  'NEEDS_REVIEW',
  'ASSIGNED',
  'WATCHING',
  'RESOLVED',
  'DISMISSED',
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export const QUEUE_STATE_LABEL: Record<QueueState, string> = {
  NEEDS_REVIEW: 'Needs review',
  ASSIGNED: 'Assigned',
  WATCHING: 'Watching',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
};

/**
 * Whether a lane can hold anything yet, and if not, why.
 *
 * This is the honest-empty-state rule applied to a workflow rather than to a
 * number: "Assigned — 0" is indistinguishable from "assignment does not exist
 * yet", and only one of those is acceptable to show without explanation.
 */
export interface LaneAvailability {
  state: QueueState;
  label: string;
  available: boolean;
  /** Present whenever `available` is false. */
  unavailableReason: string | null;
}

const NOT_YET_PERSISTED =
  'Loop does not yet remember operator decisions between visits, so nothing can be in this lane. It fills once the decision lifecycle is durable.';

export function laneAvailability(): LaneAvailability[] {
  return QUEUE_STATES.map((state) => ({
    state,
    label: QUEUE_STATE_LABEL[state],
    available: state === 'NEEDS_REVIEW',
    unavailableReason: state === 'NEEDS_REVIEW' ? null : NOT_YET_PERSISTED,
  }));
}

// --- Escalation ------------------------------------------------------------------
//
// "How bad is this" answered from measured facts rather than from a probability
// Loop has no model to produce. Five of the six states require knowing what Loop
// said yesterday, which is memory — so today only NEW and UNKNOWN are reachable,
// and `escalationLimitation` states why rather than defaulting to "new" and
// implying a first sighting Loop cannot actually establish.

export const ESCALATION_STATES = [
  'NEW',
  'GETTING_WORSE',
  'HOLDING',
  'EASING',
  'SPREADING',
  'APPROACHING_LIMIT',
  'UNKNOWN',
] as const;
export type EscalationState = (typeof ESCALATION_STATES)[number];

export const ESCALATION_LABEL: Record<EscalationState, string> = {
  NEW: 'New',
  GETTING_WORSE: 'Getting worse',
  HOLDING: 'Holding',
  EASING: 'Easing',
  SPREADING: 'Spreading',
  APPROACHING_LIMIT: 'Approaching a limit',
  UNKNOWN: 'Not established',
};

export interface Escalation {
  state: EscalationState;
  /** The measured basis, or the reason the state could not be established. */
  basis: string;
  /** True when a richer state was possible in principle but the data was absent. */
  withheld: boolean;
}

/**
 * Classify escalation from what is knowable in a single request.
 *
 * SPREADING is genuinely measurable now — a cluster whose members touch more
 * than one dimension is spreading by observation, not by recollection. The rest
 * are comparisons against a previous sighting and are withheld.
 */
export function escalationOf(cluster: ReasoningCluster): Escalation {
  const dimensions = new Set<string>();
  for (const m of cluster.members) {
    for (const e of m.affectedEntities) dimensions.add(e.entityType);
  }
  // 'window' is the period itself, not a dimension — a headline change plus one
  // dimension is a normal attribution, not something spreading across the book.
  dimensions.delete('window');

  if (dimensions.size > 1) {
    return {
      state: 'SPREADING',
      basis: `Observed across ${dimensions.size} parts of the marketplace in this period, not just one.`,
      withheld: false,
    };
  }
  return {
    state: 'UNKNOWN',
    basis:
      'Whether this is new, worsening or easing cannot be established: Loop does not yet retain what it reported in prior periods, so it has nothing to compare this sighting against.',
    withheld: true,
  };
}

// --- The reasoning chain, with a stated end --------------------------------------
//
// The most important honesty device in the product. A chain either stops
// silently (and the reader assumes it ended because there was nothing more) or
// keeps going past its evidence. Neither is acceptable, so every chain names its
// own terminus and what would extend it.

export interface ChainLink {
  /** The claim at this link, in business language. */
  statement: string;
  /** The measured basis for the step from the previous link to this one. */
  basis: string | null;
  /** How strongly the step is supported: attribution, formula lineage, or observation. */
  support: 'observed' | 'attributed' | 'follows_by_formula';
}

export interface ReasoningChain {
  links: ChainLink[];
  /** Where Loop's knowledge stops. Never null — a complete chain still has an end. */
  terminus: string;
  /** What would extend the chain past the terminus. */
  wouldExtend: string;
}

function chainOf(cluster: ReasoningCluster): ReasoningChain {
  const byId = new Map(cluster.members.map((m) => [m.id, m] as const));
  const links: ChainLink[] = [
    { statement: cluster.anchor.plainLanguageSummary, basis: null, support: 'observed' },
  ];

  // Attribution first — where the change came from arithmetically.
  const attributions = cluster.relations.filter(
    (r) => r.targetId === cluster.anchor.id
      && (r.kind === 'LIKELY_ROOT_CAUSE' || r.kind === 'POSSIBLE_CONTRIBUTOR'),
  );
  for (const r of attributions.slice(0, 2)) {
    const source = byId.get(r.sourceId);
    if (!source) continue;
    links.push({
      statement: source.plainLanguageSummary,
      basis: r.measurement ?? r.basis,
      support: 'attributed',
    });
  }

  // Then what follows structurally, which is a fact about the formulas.
  const downstream = cluster.relations.filter(
    (r) => r.sourceId === cluster.anchor.id && r.kind === 'DOWNSTREAM_EFFECT',
  );
  for (const r of downstream.slice(0, 2)) {
    const target = byId.get(r.targetId);
    if (!target) continue;
    links.push({
      statement: target.plainLanguageSummary,
      basis: r.measurement ?? r.basis,
      support: 'follows_by_formula',
    });
  }

  // The terminus. Loop can attribute a change and follow it through the metric
  // formulas; it cannot observe intent, routing, caps, budgets or schedules. That
  // boundary is the same everywhere, and it is usually where the action lives.
  const deps = [...new Set(cluster.relations.flatMap((r) => r.unknownDependencies))];
  const subject = cluster.anchor.affectedEntities[0]?.entityName ?? null;

  return {
    links,
    terminus: subject
      ? `Loop's knowledge stops here. Why ${subject} behaved this way is not present in any data Loop receives.`
      : "Loop's knowledge stops here. Loop can attribute this change arithmetically and follow it through the metric formulas, but it cannot observe why it happened.",
    wouldExtend:
      deps[0]
      ?? (subject
        ? `Speaking to ${subject}, or ingesting the commercial terms behind the relationship.`
        : 'Data Loop does not currently receive: routing configuration, caps, budgets, schedules or commercial terms.'),
  };
}

// --- Loop's read ------------------------------------------------------------------
//
// What separates an analyst from a threshold: a claim, its basis, the evidence
// that ARGUES AGAINST it, the boundary of what Loop can see, and what would
// change its mind.
//
// The disconfirming field is the point. A system that only ever reports
// supporting evidence is indistinguishable from one that cannot look for the
// other kind, and an operator has no way to calibrate it. Nothing here is a
// probability — every clause traces to a measured value, so a reader who doubts
// the read can check it.

export interface LoopRead {
  /** What Loop thinks is going on. One sentence. */
  claim: string;
  /** The measurement that supports it. */
  because: string;
  /**
   * Measured evidence that argues against the claim, or an explicit statement
   * that nothing measured contradicts it. Never empty.
   */
  arguesAgainst: string;
  /** The boundary — what Loop cannot see about this Situation. */
  cannotSee: string;
  /** The observation that would change the read. */
  wouldChange: string;
}

function readOf(cluster: ReasoningCluster, chain: ReasoningChain): LoopRead {
  const anchor = cluster.anchor;
  const subject = anchor.affectedEntities[0]?.entityName ?? null;

  // The claim is the cluster's own narrative first sentence set — it is already
  // composed from measured relations only, so it cannot assert more than the
  // edges do. Nothing is re-worded here; re-wording is where drift starts.
  const claim = cluster.hasRootCause && subject
    ? `This traces to ${subject} rather than to a broad shift.`
    : cluster.members.length === 1
      ? 'This appears isolated rather than systemic.'
      : `This is one movement showing up in ${cluster.members.length} places, not ${cluster.members.length} separate problems.`;

  const rootRelation = cluster.relations.find(
    (r) => r.kind === 'LIKELY_ROOT_CAUSE' && r.targetId === anchor.id,
  );
  const because = rootRelation
    ? (rootRelation.measurement ?? rootRelation.basis)
    : anchor.plainLanguageSummary;

  // Disconfirming evidence: a competing contributor is the strongest form, since
  // it directly weakens a single-origin claim. Absent one, say plainly that
  // nothing measured contradicts the read — which is a finding, not a filler.
  const competitors = cluster.relations.filter(
    (r) => r.kind === 'POSSIBLE_CONTRIBUTOR' && r.targetId === anchor.id,
  );
  const correlated = cluster.relations.filter((r) => r.kind === 'CORRELATED_CHANGE');
  const arguesAgainst = competitors.length > 0
    ? `${competitors.length} other contributor${competitors.length === 1 ? '' : 's'} also account${competitors.length === 1 ? 's' : ''} for part of this change, so it is not a single-origin movement.`
    : correlated.length > 0
      ? `${correlated.length} other change${correlated.length === 1 ? '' : 's'} in this period concern the same entity or metric family. They co-occur, and Loop cannot establish which leads.`
      : 'Nothing measured contradicts this read. No competing contributor accounts for a material share of the change.';

  return {
    claim,
    because,
    arguesAgainst,
    cannotSee: chain.terminus,
    wouldChange: chain.wouldExtend,
  };
}

// --- The Situation -----------------------------------------------------------------

export interface Situation {
  /**
   * Stable across runs for the same underlying event, so a later increment can
   * recognise the same Situation tomorrow rather than filing a second one.
   * Derived from the anchor's rule and entity — never from a timestamp.
   */
  key: string;
  /** Unique within one analysis. */
  id: string;
  title: string;
  /** What happened. Measured, no interpretation. */
  whatHappened: string;
  /** Why it matters. Loop's reading, labelled as such by the field name. */
  whyItMatters: string;
  severity: Severity;
  /** Attention ordering only. Never rendered as a value or a probability. */
  score: IntelligenceScore;
  reviewPriority: ReviewUrgency;
  queueState: QueueState;
  escalation: Escalation;
  /** The money. Carries its own label — exposure, decline, or gap; never upside. */
  impact: BusinessImpact;
  /** The decision the operator must make, in review language. */
  decision: string | null;
  /** What continues if nothing is done. Arithmetic on a measured rate. */
  ifIgnored: string | null;
  read: LoopRead;
  chain: ReasoningChain;
  /** How many findings merged into this Situation. Always disclosed. */
  observationCount: number;
  /** The merged findings, so the merge is reversible by the reader. */
  observations: CallGridFinding[];
  /** The decision-support cards behind it, for the evidence layer. */
  cards: DecisionSupportCard[];
  /** Set when this Situation is an opportunity rather than a problem. */
  opportunity: Opportunity | null;
  /** What Loop cannot determine about this Situation specifically. */
  unknowns: string[];
  version: string;
}

export interface SituationInput {
  reasoning: OperationalReasoning;
  ranked: readonly ScoredFinding[];
  decisionSupport: readonly DecisionSupportCard[];
  opportunities: readonly Opportunity[];
}

export interface SituationQueue {
  /** Attention-ordered. The cut to a handful happens in the surface, not here. */
  situations: Situation[];
  lanes: LaneAvailability[];
  /** Count per lane. Every lane but NEEDS_REVIEW is 0 until lifecycle persists. */
  counts: Record<QueueState, number>;
  /**
   * Stated when the queue is empty — an all-clear must say what was examined,
   * because "nothing needed you" and "nothing could be read" look identical
   * otherwise and only one of them is good news.
   */
  emptyReason: string | null;
  version: string;
}

/**
 * Project clusters into ranked Situations.
 *
 * A Situation inherits the score of its BEST-scoring member: an event is as
 * important as the most important thing observed about it. Taking the anchor's
 * score instead would let a high-severity-but-low-score anchor mask a member
 * that genuinely deserves attention.
 */
export function buildSituations(input: SituationInput): Situation[] {
  const scoreByFinding = new Map(input.ranked.map((r) => [r.finding.id, r.score] as const));
  const cardsByFinding = new Map(input.decisionSupport.map((c) => [c.findingId, c] as const));
  const oppByFinding = new Map(input.opportunities.map((o) => [o.finding.id, o] as const));

  const situations: Situation[] = [];

  for (const cluster of input.reasoning.clusters) {
    // Best-scoring member drives ordering and the headline money.
    const scored = cluster.members
      .map((m) => ({ finding: m, score: scoreByFinding.get(m.id) ?? null }))
      .filter((m): m is { finding: CallGridFinding; score: IntelligenceScore } => m.score !== null)
      .sort((a, b) => b.score.score - a.score.score || a.finding.id.localeCompare(b.finding.id));

    // A cluster whose members were all filtered out of scoring has nothing to
    // rank by. Skipping is correct: it cannot be positioned in a queue, and
    // guessing a position would put it above or below things arbitrarily.
    const lead = scored[0];
    if (!lead) continue;

    const cards = cluster.members
      .map((m) => cardsByFinding.get(m.id))
      .filter((c): c is DecisionSupportCard => !!c);

    // The money comes from the card with the largest measured amount in the
    // cluster — the event's headline number, not the anchor's incidentally.
    const withMoney = cards
      .filter((c) => c.businessImpact.amountCents !== null)
      .sort((a, b) => Math.abs(b.businessImpact.amountCents!) - Math.abs(a.businessImpact.amountCents!));
    const impact = withMoney[0]?.businessImpact ?? cards[0]?.businessImpact ?? NO_IMPACT_FALLBACK;

    const leadCard = cardsByFinding.get(lead.finding.id) ?? cards[0] ?? null;
    const chain = chainOf(cluster);

    // Review priority is the most urgent among the merged cards. Merging must
    // never soften urgency: if one observation warranted attention today, the
    // Situation containing it warrants attention today.
    const priority = cards.length > 0
      ? cards.reduce<ReviewUrgency>(
          (worst, c) =>
            REVIEW_URGENCY_RANK[c.reviewPriority] < REVIEW_URGENCY_RANK[worst] ? c.reviewPriority : worst,
          cards[0]!.reviewPriority,
        )
      : 'INFORMATIONAL';

    // Severity likewise takes the worst in the cluster.
    const severity = cluster.members.reduce<Severity>(
      (worst, m) => (SEVERITY_RANK[m.severity] < SEVERITY_RANK[worst] ? m.severity : worst),
      cluster.anchor.severity,
    );

    situations.push({
      key: recurrenceKey(cluster.anchor),
      id: cluster.id,
      title: cluster.anchor.title,
      whatHappened: leadCard?.observation ?? cluster.anchor.plainLanguageSummary,
      whyItMatters: leadCard?.interpretation ?? cluster.narrative,
      severity,
      score: lead.score,
      reviewPriority: priority,
      // Derived, not stored. Every Situation needs review because Loop cannot yet
      // remember that one was assigned, watched or dismissed.
      queueState: 'NEEDS_REVIEW',
      escalation: escalationOf(cluster),
      impact,
      decision: leadCard?.recommendedReview ?? cluster.anchor.recommendedReview,
      ifIgnored: ifIgnoredOf(impact),
      read: readOf(cluster, chain),
      chain,
      observationCount: cluster.members.length,
      observations: cluster.members,
      cards,
      opportunity: cluster.members.map((m) => oppByFinding.get(m.id)).find((o) => !!o) ?? null,
      unknowns: [...new Set([...cluster.unknowns, ...cluster.members.flatMap((m) => m.unknowns)])],
      version: SITUATION_VERSION,
    });
  }

  return situations.sort(bySituationAttention);
}

const NO_IMPACT_FALLBACK: BusinessImpact = {
  kind: 'none',
  amountCents: null,
  label: 'Not quantifiable',
  statement: 'This has no monetary dimension that Loop can measure.',
  annualizedCents: null,
  annualizationBasis: null,
};

/**
 * What continues if nobody acts.
 *
 * Only ever a restatement of the measured rate under a stated condition. The
 * counterpart question — what acting would achieve — is deliberately absent:
 * that requires modelling a counterfactual whose constraints (contracts,
 * capacity, budgets, intent) Loop cannot see, and a number there would be read
 * as a recovery estimate and used to justify a decision it cannot support.
 */
function ifIgnoredOf(impact: BusinessImpact): string | null {
  if (impact.amountCents === null) return null;
  if (impact.annualizationBasis) return impact.annualizationBasis;
  return `${impact.statement} Loop cannot say what acting would recover — that depends on information it does not receive.`;
}

/** Attention order: score, then urgency, then severity, then a stable key. */
export function bySituationAttention(a: Situation, b: Situation): number {
  if (b.score.score !== a.score.score) return b.score.score - a.score.score;
  const u = REVIEW_URGENCY_RANK[a.reviewPriority] - REVIEW_URGENCY_RANK[b.reviewPriority];
  if (u !== 0) return u;
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (s !== 0) return s;
  return a.key.localeCompare(b.key);
}

/**
 * Assemble the queue.
 *
 * `reportOk` is passed separately because an unreadable report and a genuinely
 * quiet period produce the same empty list, and telling an operator "nothing
 * needs you" when Loop could not read the data would be the worst single
 * sentence this product could emit.
 */
export function buildQueue(
  input: SituationInput,
  context: { reportOk: boolean; periodLabel: string },
): SituationQueue {
  const situations = buildSituations(input);
  const counts = QUEUE_STATES.reduce(
    (acc, s) => ({ ...acc, [s]: situations.filter((x) => x.queueState === s).length }),
    {} as Record<QueueState, number>,
  );

  const emptyReason = situations.length > 0
    ? null
    : !context.reportOk
      ? 'Loop could not read CallGrid for this period, so it cannot tell you whether anything needs attention. This is not an all-clear.'
      : `Nothing needs your attention for ${context.periodLabel}. Every significance rule was evaluated and none of them cleared its threshold.`;

  return { situations, lanes: laneAvailability(), counts, emptyReason, version: SITUATION_VERSION };
}

// --- The briefing --------------------------------------------------------------------
//
// The nine-word answer to "is there a fire", followed by the sequencing sentence.
// Assembled from the ranked Situations, never authored beside them: one source,
// two renderings, so the briefing cannot say something the queue does not carry.

export interface Briefing {
  /** The opener. Answers "is there a fire" before anything else. */
  opener: string;
  /** Why the first item is first. The single most valuable string on the page. */
  sequencing: string | null;
  /** Total money measured across the surfaced Situations, when any is measurable. */
  measuredImpactCents: number | null;
  /** Disclosed when some Situations carry no measurable amount. */
  unpricedCount: number;
}

function fmtMoney(cents: number): string {
  return '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

export function buildBriefing(
  queue: SituationQueue,
  context: { periodLabel: string },
): Briefing {
  const shown = queue.situations;
  if (shown.length === 0) {
    return {
      opener: queue.emptyReason ?? `Nothing needs your attention for ${context.periodLabel}.`,
      sequencing: null,
      measuredImpactCents: null,
      unpricedCount: 0,
    };
  }

  // "Fires" are the ones a person should look at today. Everything else is a
  // thing to know about, and the opener must not conflate them.
  const urgent = shown.filter(
    (s) => s.reviewPriority === 'IMMEDIATE' || s.reviewPriority === 'TODAY',
  ).length;
  const rest = shown.length - urgent;

  const opener = urgent === 0
    ? `Nothing urgent. ${rest} thing${rest === 1 ? '' : 's'} to look at.`
    : `${urgent === 1 ? 'One fire' : `${urgent} fires`}${rest > 0 ? `, ${rest} thing${rest === 1 ? '' : 's'} to look at` : ''}.`;

  const first = shown[0]!;
  const priced = shown.filter((s) => s.impact.amountCents !== null);
  const total = priced.length > 0
    ? priced.reduce((sum, s) => sum + Math.abs(s.impact.amountCents!), 0)
    : null;

  // The sequencing sentence names the reason the first item is first. A COO does
  // not just list; they sequence, and they say why.
  const reason = first.impact.amountCents !== null && priced.length > 1
    ? `it is the largest measured amount at ${fmtMoney(first.impact.amountCents)}`
    : first.reviewPriority === 'IMMEDIATE' || first.reviewPriority === 'TODAY'
      ? 'it is the only one where today changes the outcome'
      : 'it carries the strongest evidence of the things surfaced';

  return {
    opener,
    sequencing: `Start with ${first.title} — ${reason}.`,
    measuredImpactCents: total,
    unpricedCount: shown.length - priced.length,
  };
}

// --- Page-level unknowns ---------------------------------------------------------------

/** What the queue itself could not establish, distinct from any one Situation's gaps. */
export function queueUnknowns(queue: SituationQueue): IntelligenceUnknown[] {
  const out: IntelligenceUnknown[] = [];

  if (queue.situations.some((s) => s.escalation.withheld)) {
    out.push({
      id: 'situation:escalation-history',
      statement: 'Whether these are new, worsening or easing.',
      reason:
        'Loop does not yet retain what it reported in prior periods, so it cannot compare this sighting against an earlier one.',
    });
  }

  const unavailable = queue.lanes.filter((l) => !l.available);
  if (unavailable.length > 0) {
    out.push({
      id: 'situation:lifecycle',
      statement: `Whether anyone is already working on these (${unavailable.map((l) => l.label.toLowerCase()).join(', ')}).`,
      reason: NOT_YET_PERSISTED,
    });
  }

  return out;
}
