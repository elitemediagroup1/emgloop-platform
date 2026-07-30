// The Operational Reasoning layer — findings as a connected system.
//
// THE CLAIM THIS FILE IS ALLOWED TO MAKE, AND THE ONE IT IS NOT
//
// From call records Loop can establish exactly two kinds of relationship:
//
//   1. ARITHMETIC ATTRIBUTION — "this entity accounts for 62% of the revenue
//      change" is a fact about where a number came from. It is subtraction, not
//      a theory.
//   2. FORMULA LINEAGE — profit is `revenue − payout − cost`, so a profit move is
//      structurally downstream of a revenue move. Concentration is computed from
//      entity revenue, so it is downstream of entity revenue. These are facts
//      about the formulas, not guesses about the world.
//
// It CANNOT establish mechanism. Nothing here knows why a buyer sent less
// traffic, and nothing in CallGrid would tell it. So `LIKELY_ROOT_CAUSE` in this
// file means "this is where the change came from", in the accounting sense —
// never "this is why it happened". Every card that renders it says so, and a test
// asserts the phrase "root cause" never appears without that qualification.
//
// Two things changing together is the weakest relationship here, and it is
// labelled CORRELATED_CHANGE precisely so it cannot be read as anything more.
//
// CONSUMES, NEVER RECOMPUTES
// Every input is a finding the engine already produced or a series the history
// layer already loaded. This module performs no aggregation and defines no metric.

import {
  SEVERITY_RANK,
  type AffectedEntity,
  type CallGridFinding,
  type Severity,
} from './callgrid-intelligence';
import {
  MIN_SERIES_POINTS, entitySeries, extremeVersusSeries, historyEntityKey,
  mean, oscillations, trendPerPeriod, volatility, type HistorySeries,
} from './callgrid-history';

export const REASONING_VERSION = 'v1';

// --- Relationship classification --------------------------------------------------

export const RELATION_KINDS = [
  'LIKELY_ROOT_CAUSE',
  'POSSIBLE_CONTRIBUTOR',
  'DOWNSTREAM_EFFECT',
  'CORRELATED_CHANGE',
  'INDEPENDENT_EVENT',
  'UNKNOWN',
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const RELATION_LABEL: Record<RelationKind, string> = {
  LIKELY_ROOT_CAUSE: 'Likely Root Cause',
  POSSIBLE_CONTRIBUTOR: 'Possible Contributor',
  DOWNSTREAM_EFFECT: 'Downstream Effect',
  CORRELATED_CHANGE: 'Correlated Change',
  INDEPENDENT_EVENT: 'Independent Event',
  UNKNOWN: 'Unknown',
};

/**
 * What each label is allowed to mean. Rendered verbatim next to the badge, so a
 * reader is never left to supply their own definition of "root cause".
 */
export const RELATION_DEFINITION: Record<RelationKind, string> = {
  LIKELY_ROOT_CAUSE:
    'Arithmetic attribution: this accounts for most of the measured change. It identifies WHERE the change came from, not why it happened — Loop cannot see the mechanism.',
  POSSIBLE_CONTRIBUTOR:
    'This accounts for a material share of the measured change, alongside others. Contribution, not cause.',
  DOWNSTREAM_EFFECT:
    'Structurally derived from the other finding by formula — for example profit is revenue minus payout and cost, so a profit move follows a revenue move by construction.',
  CORRELATED_CHANGE:
    'Both moved in the same period and concern the same entity or metric family. Co-occurrence only — no direction is implied in either direction.',
  INDEPENDENT_EVENT:
    'No measured relationship to the other findings in this period.',
  UNKNOWN:
    'A relationship may exist but the evidence available cannot establish it.',
};

/** Contribution share at which one entity is treated as the arithmetic origin of a change. */
const ROOT_CAUSE_SHARE = 0.6;
/** Share at which a competing entity blocks a root-cause claim. */
const COMPETING_SHARE = 0.25;
/** Contribution share below which an entity is not worth naming as a contributor. */
const CONTRIBUTOR_SHARE = 0.15;

export interface ReasoningRelation {
  /** The finding being explained. */
  targetId: string;
  /** The finding offered as explanation, contributor, or co-occurrence. */
  sourceId: string;
  kind: RelationKind;
  /** 0–1, deterministic — the weaker of the two findings' confidences, damped by kind. */
  confidence: number;
  /** Why Loop believes these are related, in one sentence. */
  basis: string;
  /** The measured quantity behind the claim, when there is one. */
  measurement: string | null;
  /** What would be needed to strengthen this into a causal claim. */
  unknownDependencies: string[];
}

const METRIC_FAMILY: Record<string, string> = {
  revenue: 'economics',
  profit: 'economics',
  revenuePerBillableCall: 'economics',
  revenueShare: 'economics',
  totalCalls: 'traffic',
  billableRate: 'traffic',
};

/**
 * Formula lineage: which metric is structurally derived from which.
 *
 * These are facts about the metric contract, not inferences. Profit subtracts
 * from revenue; share divides by a window total; value-per-call divides revenue
 * by billable calls.
 */
const DERIVED_FROM: Record<string, readonly string[]> = {
  profit: ['revenue'],
  revenueShare: ['revenue'],
  revenuePerBillableCall: ['revenue', 'billableRate'],
  billableRate: ['totalCalls'],
};

function primaryEntity(f: CallGridFinding): AffectedEntity | null {
  return f.affectedEntities[0] ?? null;
}

function sharesEntity(a: CallGridFinding, b: CallGridFinding): string | null {
  const ea = primaryEntity(a);
  const eb = primaryEntity(b);
  if (!ea || !eb) return null;
  if (ea.entityId && eb.entityId && ea.entityId === eb.entityId) return ea.entityName || ea.entityId;
  return null;
}

/** The contribution `source`'s entity makes to `target`'s change, when measured. */
function contributionOf(target: CallGridFinding, source: CallGridFinding): { share: number; entity: string } | null {
  const sourceEntity = primaryEntity(source);
  if (!sourceEntity?.entityId) return null;
  const driver = target.drivers.find((d) => d.entityId === sourceEntity.entityId);
  if (!driver || driver.contributionToChange === null) return null;
  return { share: Math.abs(driver.contributionToChange), entity: driver.entityName || driver.entityId || 'this entity' };
}

/**
 * Classify how `source` relates to `target`.
 *
 * Order matters: attribution is checked before lineage, and lineage before
 * co-occurrence, so the strongest SUPPORTED claim wins and nothing is upgraded
 * beyond its evidence.
 */
export function relate(
  target: CallGridFinding,
  source: CallGridFinding,
  allFindings: readonly CallGridFinding[],
): ReasoningRelation | null {
  if (target.id === source.id) return null;

  const baseConfidence = Math.min(target.confidence, source.confidence);
  const unknownDeps = [
    'The mechanism. CallGrid exposes no routing decision, cap state, schedule, budget or demand signal, so no relationship here can be raised to a causal claim.',
  ];

  // 1 — Arithmetic attribution.
  const contribution = contributionOf(target, source);
  if (contribution && contribution.share >= CONTRIBUTOR_SHARE) {
    // A root-cause claim requires dominance AND no serious competitor.
    const competitors = target.drivers.filter(
      (d) =>
        d.entityId !== primaryEntity(source)?.entityId &&
        d.contributionToChange !== null &&
        Math.abs(d.contributionToChange) >= COMPETING_SHARE,
    );
    const dominant = contribution.share >= ROOT_CAUSE_SHARE && competitors.length === 0;
    return {
      targetId: target.id,
      sourceId: source.id,
      kind: dominant ? 'LIKELY_ROOT_CAUSE' : 'POSSIBLE_CONTRIBUTOR',
      confidence: Math.round(baseConfidence * (dominant ? 0.95 : 0.8) * 100) / 100,
      basis: dominant
        ? `${contribution.entity} accounts for ${Math.round(contribution.share * 100)}% of the measured change, and no other entity accounts for ${Math.round(COMPETING_SHARE * 100)}% or more. This identifies where the change came from, not why it happened.`
        : `${contribution.entity} accounts for ${Math.round(contribution.share * 100)}% of the measured change, alongside ${competitors.length} other material contributor${competitors.length === 1 ? '' : 's'}.`,
      measurement: `${Math.round(contribution.share * 100)}% of the change in ${target.primaryMetric}`,
      unknownDependencies: unknownDeps,
    };
  }

  // 2 — Formula lineage. A structural fact about the metric contract.
  const parents = DERIVED_FROM[target.primaryMetric] ?? [];
  if (parents.includes(source.primaryMetric)) {
    return {
      targetId: target.id,
      sourceId: source.id,
      kind: 'DOWNSTREAM_EFFECT',
      confidence: Math.round(baseConfidence * 0.9 * 100) / 100,
      basis: `${target.primaryMetric} is computed from ${source.primaryMetric} by the metric contract, so a move in one follows the other by construction rather than by inference.`,
      measurement: null,
      unknownDependencies: [
        'Whether the derived movement is fully explained by its input, or whether another component of the formula also moved.',
        ...unknownDeps,
      ],
    };
  }

  // 3 — Same entity, same period.
  const entity = sharesEntity(target, source);
  if (entity) {
    return {
      targetId: target.id,
      sourceId: source.id,
      kind: 'CORRELATED_CHANGE',
      confidence: Math.round(baseConfidence * 0.6 * 100) / 100,
      basis: `Both findings concern ${entity} in the same period. They co-occur; neither is shown to lead the other.`,
      measurement: null,
      unknownDependencies: unknownDeps,
    };
  }

  // 4 — Same metric family, no entity link.
  const famA = METRIC_FAMILY[target.primaryMetric];
  const famB = METRIC_FAMILY[source.primaryMetric];
  if (famA && famB && famA === famB) {
    return {
      targetId: target.id,
      sourceId: source.id,
      kind: 'CORRELATED_CHANGE',
      confidence: Math.round(baseConfidence * 0.45 * 100) / 100,
      basis: `Both concern ${famA} in the same period, with no shared entity to connect them further.`,
      measurement: null,
      unknownDependencies: unknownDeps,
    };
  }

  return null;
}

/** Every relation among a set of findings. */
export function relateAll(findings: readonly CallGridFinding[]): ReasoningRelation[] {
  const out: ReasoningRelation[] = [];
  for (const target of findings) {
    for (const source of findings) {
      const r = relate(target, source, findings);
      if (r) out.push(r);
    }
  }
  return out;
}

// --- Clusters ---------------------------------------------------------------------

export interface ReasoningCluster {
  id: string;
  /** The finding the cluster is organised around — highest severity, then score. */
  anchor: CallGridFinding;
  members: CallGridFinding[];
  relations: ReasoningRelation[];
  /** Deterministic business narrative. Template language, no model. */
  narrative: string;
  /** Whether the cluster names an arithmetic origin. */
  hasRootCause: boolean;
  /** Cascading effects supported by formula lineage or measured contribution only. */
  likelyDownstream: string[];
  unknowns: string[];
}

function bySeverityThenChange(a: CallGridFinding, b: CallGridFinding): number {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (s !== 0) return s;
  return Math.abs(b.absoluteChange ?? 0) - Math.abs(a.absoluteChange ?? 0);
}

function money(cents: number | null): string {
  if (cents === null) return 'an unknown amount';
  return (cents < 0 ? '-' : '') + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

/**
 * Group findings into connected clusters.
 *
 * Union-find over the relation edges. A finding with no relation becomes its own
 * single-member cluster and is described as isolated — which is itself useful:
 * "this appears isolated rather than systemic" is a real business statement.
 */
export function clusterFindings(findings: readonly CallGridFinding[]): ReasoningCluster[] {
  const relations = relateAll(findings);
  const parent = new Map<string, string>();
  for (const f of findings) parent.set(f.id, f.id);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) { const next = parent.get(x)!; parent.set(x, root); x = next; }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const r of relations) union(r.targetId, r.sourceId);

  const byRoot = new Map<string, CallGridFinding[]>();
  for (const f of findings) {
    const root = find(f.id);
    const list = byRoot.get(root) ?? [];
    list.push(f);
    byRoot.set(root, list);
  }

  const clusters: ReasoningCluster[] = [];
  for (const [root, members] of byRoot) {
    const sorted = [...members].sort(bySeverityThenChange);
    const anchor = sorted[0]!;
    const ids = new Set(members.map((m) => m.id));
    const clusterRelations = relations.filter((r) => ids.has(r.targetId) && ids.has(r.sourceId));
    const built = narrateCluster(anchor, sorted, clusterRelations);
    clusters.push({
      id: `cluster:${root}`,
      anchor,
      members: sorted,
      relations: clusterRelations,
      ...built,
    });
  }

  return clusters.sort((a, b) => bySeverityThenChange(a.anchor, b.anchor));
}

/**
 * Compose a cluster's narrative from measured relations only.
 *
 * Deterministic template language. Every clause is backed by a relation that was
 * already classified, so the narrative cannot assert more than the edges do.
 */
function narrateCluster(
  anchor: CallGridFinding,
  members: readonly CallGridFinding[],
  relations: readonly ReasoningRelation[],
): { narrative: string; hasRootCause: boolean; likelyDownstream: string[]; unknowns: string[] } {
  const rootCauses = relations.filter((r) => r.kind === 'LIKELY_ROOT_CAUSE' && r.targetId === anchor.id);
  const contributors = relations.filter((r) => r.kind === 'POSSIBLE_CONTRIBUTOR' && r.targetId === anchor.id);
  const downstream = relations.filter((r) => r.kind === 'DOWNSTREAM_EFFECT' && r.sourceId === anchor.id);
  const correlated = relations.filter((r) => r.kind === 'CORRELATED_CHANGE');

  const byId = new Map(members.map((m) => [m.id, m] as const));
  const sentences: string[] = [];

  // 1 — What happened.
  sentences.push(anchor.plainLanguageSummary);

  // 2 — Where it came from.
  if (rootCauses.length > 0) {
    const r = rootCauses[0]!;
    sentences.push(
      `Most of that change is attributable to one place: ${r.basis}`,
    );
  } else if (contributors.length > 0) {
    const names = contributors
      .map((c) => byId.get(c.sourceId))
      .filter((f): f is CallGridFinding => !!f)
      .map((f) => primaryEntity(f)?.entityName ?? f.title)
      .slice(0, 3);
    sentences.push(
      `The change is spread across ${contributors.length} contributor${contributors.length === 1 ? '' : 's'} rather than originating in one place` +
      (names.length > 0 ? ` — ${names.join(', ')}.` : '.'),
    );
  } else if (members.length === 1) {
    sentences.push(
      'No other finding in this period is measurably related to it, so it appears isolated rather than systemic.',
    );
  }

  // 3 — What follows structurally.
  const likelyDownstream: string[] = [];
  for (const d of downstream) {
    const child = byId.get(d.targetId);
    if (!child) continue;
    likelyDownstream.push(`${child.title} — ${d.basis}`);
  }
  if (likelyDownstream.length > 0) {
    sentences.push(
      `${likelyDownstream.length} further finding${likelyDownstream.length === 1 ? ' follows' : 's follow'} from it by formula rather than by inference.`,
    );
  }

  // 4 — Co-occurrence, explicitly weak.
  if (correlated.length > 0 && rootCauses.length === 0) {
    sentences.push(
      `${correlated.length} other change${correlated.length === 1 ? '' : 's'} in this period ${correlated.length === 1 ? 'concerns' : 'concern'} the same entity or metric family. They co-occur; Loop cannot establish which, if any, leads the others.`,
    );
  }

  const unknowns = [...new Set(relations.flatMap((r) => r.unknownDependencies))];
  if (unknowns.length === 0) {
    unknowns.push('No relationship to other findings could be measured for this period.');
  }

  return {
    narrative: sentences.join(' '),
    hasRootCause: rootCauses.length > 0,
    likelyDownstream,
    unknowns,
  };
}

// --- Stability --------------------------------------------------------------------

export const STABILITY_CLASSES = [
  'STABLE', 'IMPROVING', 'DETERIORATING', 'RECOVERING',
  'VOLATILE', 'EMERGING', 'DECLINING', 'DORMANT', 'UNKNOWN',
] as const;
export type StabilityClass = (typeof STABILITY_CLASSES)[number];

export const STABILITY_LABEL: Record<StabilityClass, string> = {
  STABLE: 'Stable', IMPROVING: 'Improving', DETERIORATING: 'Deteriorating',
  RECOVERING: 'Recovering', VOLATILE: 'Volatile', EMERGING: 'Emerging',
  DECLINING: 'Declining', DORMANT: 'Dormant', UNKNOWN: 'Unknown',
};

export interface StabilityAssessment {
  entityKey: string;
  entityName: string;
  classification: StabilityClass;
  /** Why, in one sentence, naming the measured basis. */
  basis: string;
  /** Complete periods the classification rests on. */
  periods: number;
  confidence: number;
}

/**
 * Classify an entity's behaviour across COMPLETED periods only.
 *
 * Returns UNKNOWN — never a guess — below the minimum series. The order of checks
 * matters: dormancy and emergence are shape facts that must be established before
 * a trend is read, because a trend computed across an absence is meaningless.
 */
export function assessStability(
  dimension: string,
  entityKey: string,
  entityName: string,
  history: HistorySeries,
  currentRevenueCents: number | null,
): StabilityAssessment {
  const key = historyEntityKey(dimension, entityKey);
  const series = entitySeries(history, key);
  const usable = series.filter((v): v is number => v !== null);

  const base = { entityKey, entityName, periods: usable.length };

  if (history.points.length < MIN_SERIES_POINTS) {
    return {
      ...base, classification: 'UNKNOWN', confidence: 0,
      basis: `Fewer than ${MIN_SERIES_POINTS} complete prior periods are available, so no behaviour can be established.`,
    };
  }

  const half = Math.max(1, Math.floor(series.length / 2));
  const recent = series.slice(0, half);
  const older = series.slice(half);
  const recentActive = recent.filter((v) => v !== null && v > 0).length;
  const olderActive = older.filter((v) => v !== null && v > 0).length;

  // Shape first.
  if (recentActive === 0 && olderActive === 0 && (currentRevenueCents ?? 0) <= 0) {
    return { ...base, classification: 'DORMANT', confidence: 0.7,
      basis: `No revenue recorded across any of the ${history.points.length} complete prior periods observed.` };
  }
  if (olderActive === 0 && recentActive > 0) {
    return { ...base, classification: 'EMERGING', confidence: 0.7,
      basis: `Absent from the earliest ${older.length} periods observed and present in ${recentActive} of the ${recent.length} most recent.` };
  }
  if (recentActive === 0 && olderActive > 0) {
    return { ...base, classification: 'DORMANT', confidence: 0.75,
      basis: `Present in ${olderActive} earlier periods and absent from the ${recent.length} most recent.` };
  }

  // Volatility outranks trend: a trend line through an erratic series is a
  // description of the line, not of the business.
  const v = volatility(series);
  const flips = oscillations(series);
  if (v.value !== null && v.value >= 0.5 && (flips.value ?? 0) >= 2) {
    return { ...base, classification: 'VOLATILE', confidence: 0.7,
      basis: `Revenue varied by ${Math.round(v.value * 100)}% of its own average with ${flips.value} direction reversals across ${v.usablePoints} periods.` };
  }

  const t = trendPerPeriod(series);
  if (t.value === null) {
    return { ...base, classification: 'UNKNOWN', confidence: 0,
      basis: t.reason ?? 'No trend could be computed from the periods available.' };
  }

  // A recovering entity is one whose trend is down but whose latest point is above
  // its own average — a distinction a trend line alone would erase.
  const avg = mean(series);
  const latest = usable[0];
  if (t.value < -0.05 && latest !== undefined && avg.value !== null && latest > avg.value) {
    return { ...base, classification: 'RECOVERING', confidence: 0.6,
      basis: `The multi-period trend is downward (${Math.round(t.value * 100)}% per period) but the most recent period sits above the series average.` };
  }

  if (t.value <= -0.15) {
    return { ...base, classification: 'DECLINING', confidence: 0.75,
      basis: `Revenue fell about ${Math.abs(Math.round(t.value * 100))}% per period across ${t.usablePoints} complete periods.` };
  }
  if (t.value < -0.05) {
    return { ...base, classification: 'DETERIORATING', confidence: 0.7,
      basis: `Revenue drifted down about ${Math.abs(Math.round(t.value * 100))}% per period across ${t.usablePoints} complete periods.` };
  }
  if (t.value >= 0.05) {
    return { ...base, classification: 'IMPROVING', confidence: 0.7,
      basis: `Revenue grew about ${Math.round(t.value * 100)}% per period across ${t.usablePoints} complete periods.` };
  }
  return { ...base, classification: 'STABLE', confidence: 0.7,
    basis: `Revenue held within ${Math.abs(Math.round(t.value * 100))}% per period across ${t.usablePoints} complete periods.` };
}

// --- Intelligence timeline ---------------------------------------------------------

export interface TimelineEvent {
  /** Period index: higher is older. 0 is the selected period. */
  periodIndex: number;
  periodLabel: string;
  kind: 'PEAK' | 'TROUGH' | 'ENTITY_FIRST_SEEN' | 'ENTITY_WENT_QUIET' | 'DIRECTION_CHANGE';
  statement: string;
  /** The measured value behind the event. */
  measurement: string | null;
}

/**
 * A chronological feed built from COMPLETED periods, oldest first.
 *
 * Findings all describe the selected window, so a timeline cannot be built from
 * them — it is derived from the history series instead, which is the only place
 * sequence actually exists.
 */
export function buildTimeline(history: HistorySeries, selectedPeriodLabel: string): TimelineEvent[] {
  if (history.points.length < MIN_SERIES_POINTS) return [];

  const events: TimelineEvent[] = [];
  const points = [...history.points].reverse(); // oldest first
  const revenues = points.map((p) => p.revenueCents);
  const usable = revenues.filter((v): v is number => v !== null);
  if (usable.length < MIN_SERIES_POINTS) return [];

  const max = Math.max(...usable);
  const min = Math.min(...usable);

  const label = (i: number) => `${points.length - i} period${points.length - i === 1 ? '' : 's'} before ${selectedPeriodLabel}`;

  let lastDirection = 0;
  const seen = new Set<string>();
  const stillPresent = new Set<string>();

  points.forEach((p, i) => {
    const rev = p.revenueCents;

    if (rev !== null && rev === max) {
      events.push({ periodIndex: points.length - i, periodLabel: label(i), kind: 'PEAK',
        statement: 'Revenue reached its highest point across the observed periods.',
        measurement: money(rev) });
    }
    if (rev !== null && rev === min && max !== min) {
      events.push({ periodIndex: points.length - i, periodLabel: label(i), kind: 'TROUGH',
        statement: 'Revenue reached its lowest point across the observed periods.',
        measurement: money(rev) });
    }

    if (i > 0) {
      const prev = revenues[i - 1] ?? null;
      if (rev !== null && prev !== null && prev !== 0) {
        const delta = rev - prev;
        const dir = delta > 0 ? 1 : delta < 0 ? -1 : 0;
        if (dir !== 0 && lastDirection !== 0 && dir !== lastDirection) {
          events.push({ periodIndex: points.length - i, periodLabel: label(i), kind: 'DIRECTION_CHANGE',
            statement: `Revenue reversed direction and began ${dir > 0 ? 'rising' : 'falling'}.`,
            measurement: `${delta > 0 ? '+' : ''}${money(delta)} against the prior period` });
        }
        if (dir !== 0) lastDirection = dir;
      }
    }

    // Entity lifecycle, keyed by the namespaced series key.
    for (const [key, revenue] of Object.entries(p.entityRevenueCents)) {
      const name = p.entityLabels[key] ?? key;
      if (revenue !== null && revenue > 0) {
        if (!seen.has(key)) {
          seen.add(key);
          if (i > 0) {
            events.push({ periodIndex: points.length - i, periodLabel: label(i), kind: 'ENTITY_FIRST_SEEN',
              statement: `${name} first recorded revenue.`, measurement: money(revenue) });
          } else {
            seen.add(key);
          }
        }
        stillPresent.add(key);
      } else if (stillPresent.has(key)) {
        stillPresent.delete(key);
        events.push({ periodIndex: points.length - i, periodLabel: label(i), kind: 'ENTITY_WENT_QUIET',
          statement: `${name} stopped recording revenue.`, measurement: null });
      }
    }
  });

  // Oldest first — the sequence is the point.
  return events.sort((a, b) => b.periodIndex - a.periodIndex);
}

// --- Logical relationship graph -----------------------------------------------------

export interface GraphNode {
  id: string;
  kind: 'entity' | 'metric' | 'finding';
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: RelationKind | 'CONTRIBUTES_TO' | 'DERIVED_FROM';
  confidence: number;
  basis: string;
}

export interface RelationshipGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  version: string;
}

/**
 * A logical graph, not a visual one.
 *
 * Emitted as plain data so the Brain, Work OS or any later consumer can read the
 * reasoning without importing a rendering concern or re-deriving the edges.
 */
export function buildRelationshipGraph(
  findings: readonly CallGridFinding[],
  relations: readonly ReasoningRelation[],
): RelationshipGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const f of findings) {
    nodes.set(`finding:${f.id}`, { id: `finding:${f.id}`, kind: 'finding', label: f.title });
    nodes.set(`metric:${f.primaryMetric}`, { id: `metric:${f.primaryMetric}`, kind: 'metric', label: f.primaryMetric });
    edges.push({
      from: `finding:${f.id}`, to: `metric:${f.primaryMetric}`,
      relation: 'DERIVED_FROM', confidence: f.confidence,
      basis: 'The finding measures this metric.',
    });
    for (const e of f.affectedEntities) {
      if (!e.entityId) continue;
      const id = `entity:${e.entityType}:${e.entityId}`;
      nodes.set(id, { id, kind: 'entity', label: e.entityName || e.entityId });
      edges.push({
        from: id, to: `finding:${f.id}`,
        relation: 'CONTRIBUTES_TO', confidence: f.confidence,
        basis: `${e.entityName || e.entityId} is the entity this finding concerns.`,
      });
    }
  }

  for (const r of relations) {
    edges.push({
      from: `finding:${r.sourceId}`, to: `finding:${r.targetId}`,
      relation: r.kind, confidence: r.confidence, basis: r.basis,
    });
  }

  return { nodes: [...nodes.values()], edges, version: REASONING_VERSION };
}

// --- The reasoning result -----------------------------------------------------------

export interface OperationalReasoning {
  clusters: ReasoningCluster[];
  relations: ReasoningRelation[];
  timeline: TimelineEvent[];
  stability: StabilityAssessment[];
  graph: RelationshipGraph;
  /** The page-level executive narrative. */
  businessStory: string;
  unknowns: string[];
  version: string;
}

export interface ReasoningInput {
  findings: readonly CallGridFinding[];
  history: HistorySeries;
  selectedPeriodLabel: string;
  includesLiveData: boolean;
  /** Entities to assess for stability, per dimension. */
  entities: ReadonlyArray<{ dimension: string; key: string; name: string; revenueCents: number | null }>;
}

/**
 * The page-level Business Story.
 *
 * Composed from the clusters that already exist, so it cannot assert anything the
 * relations do not. When nothing connects, it says that — "isolated rather than
 * systemic" is a genuine and useful executive conclusion, not a failure.
 */
function composeBusinessStory(
  clusters: readonly ReasoningCluster[],
  stability: readonly StabilityAssessment[],
  input: ReasoningInput,
): string {
  if (input.findings.length === 0) {
    return `No evidence-backed finding was produced for ${input.selectedPeriodLabel.toLowerCase()}, so there is no business story to tell for this period.`;
  }

  const parts: string[] = [];
  const lead = clusters[0];

  if (lead) {
    parts.push(lead.narrative);
  }

  const connected = clusters.filter((c) => c.members.length > 1);
  const isolated = clusters.filter((c) => c.members.length === 1);

  if (clusters.length > 1) {
    parts.push(
      `Across the period, ${input.findings.length} findings group into ${clusters.length} ${clusters.length === 1 ? 'cluster' : 'clusters'}: ` +
      `${connected.length} where findings are measurably related and ${isolated.length} standing alone. ` +
      (connected.length === 0
        ? 'Nothing this period is measurably connected, which points to isolated movements rather than a systemic shift.'
        : 'Related findings are grouped so a single underlying movement is not read as several separate problems.'),
    );
  }

  const notable = stability.filter((s) => s.classification !== 'STABLE' && s.classification !== 'UNKNOWN');
  if (notable.length > 0) {
    const byClass = new Map<StabilityClass, number>();
    for (const s of notable) byClass.set(s.classification, (byClass.get(s.classification) ?? 0) + 1);
    const summary = [...byClass.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, n]) => `${n} ${STABILITY_LABEL[c].toLowerCase()}`)
      .join(', ');
    parts.push(`Across tracked entities with enough history to classify: ${summary}.`);
  } else if (stability.length > 0) {
    parts.push('No tracked entity shows behaviour outside its normal range across the completed periods observed.');
  }

  if (input.includesLiveData) {
    parts.push('The selected period is still in progress, so every statement here may change before it closes.');
  }

  return parts.join(' ');
}

/** Run the reasoning layer over an already-produced set of findings. */
export function reasonAboutFindings(input: ReasoningInput): OperationalReasoning {
  const clusters = clusterFindings(input.findings);
  const relations = relateAll(input.findings);
  const timeline = buildTimeline(input.history, input.selectedPeriodLabel);

  const stability = input.entities.map((e) =>
    assessStability(e.dimension, e.key, e.name, input.history, e.revenueCents),
  );

  const unknowns: string[] = [];
  if (input.history.points.length < MIN_SERIES_POINTS) {
    unknowns.push(
      `Sequence and stability cannot be established: they need at least ${MIN_SERIES_POINTS} complete prior periods, and ${input.history.points.length} were available.`,
    );
  }
  if (relations.length === 0 && input.findings.length > 1) {
    unknowns.push(
      'No measured relationship connects this period\'s findings. They are reported separately rather than joined by an assumed link.',
    );
  }
  unknowns.push(
    'Why any of these movements occurred. Loop can attribute a change arithmetically and follow it through the metric formulas; it cannot observe routing, caps, schedules, budgets or demand, so no relationship here is a causal claim.',
  );

  return {
    clusters,
    relations,
    timeline,
    stability,
    graph: buildRelationshipGraph(input.findings, relations),
    businessStory: composeBusinessStory(clusters, stability, input),
    unknowns,
    version: REASONING_VERSION,
  };
}

export type { Severity };
