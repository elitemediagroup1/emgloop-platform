// @emgloop/brain — Brain Briefing (a read-only projection over BrainActivity).
//
// Phase 1 (Brain Output, consumer-facing shape). PR #31 established BrainActivity
// as the Brain's single canonical output. Every diagnoser, on any subject,
// publishes that same immutable shape. What the platform still lacks is a
// STANDARD, deterministic way to PRESENT a *collection* of those activities to a
// human-facing surface. Today a consumer would have to sort, group, and triage
// BrainActivity records itself — re-deriving presentation logic in every portal,
// and (worse) reaching past BrainActivity into diagnostics/recommendation
// internals to do it. That is exactly the coupling the Constitution forbids.
//
//   BrainActivity[]  (the Brain's canonical output, from brain-activity.ts)
//        v
//   projectBrainBriefing(...)  <- this file (a PURE projection, no new decisions)
//        v
//   BrainBriefing  (one stable, consumer-facing shape)
//        v
//   Consumers: Daily Briefing, Employee workspace, Business-owner workspace,
//              Notifications, future portals
//
// A BrainBriefing is a READ-ONLY, deterministic *view* of activities the Brain
// already published. It groups by severity (critical/high first), groups by
// subject when present, and surfaces the honest edges of the Brain's knowledge —
// evidence, confidence, missing evidence, alternatives, and unknowns — WITHOUT
// collapsing or fabricating any of them. Inconclusive activities are called out
// explicitly rather than hidden. The projection invents NOTHING: every value is
// copied from a BrainActivity. It performs no persistence, no I/O, no clock, no
// RNG, and it is not wired into any runtime path. Given the same activities it
// always returns the same BrainBriefing.
//
// This is NOT a UI. It is the single shape a UI (or a notification, or a daily
// briefing job) reads FROM, so that no consumer ever again reaches into the
// Brain's diagnostic internals to decide how to present output.

import type { Confidence, Visibility } from './types';
import type { AlternativeExplanation } from './recommendation';
import type {
  BrainActivity,
  BrainActivitySeverity,
  BrainActivityType,
} from './brain-activity';
import { demonstrateBrainActivityFlow } from './brain-activity';

// ---------------------------------------------------------------------------
// Model.
// ---------------------------------------------------------------------------

/** Severity bands, most urgent first. The projection ranks and orders every
 * grouping by this order so that critical/high items always surface first for
 * every consumer, identically. Reuses the shared Priority vocabulary carried by
 * BrainActivitySeverity so the whole platform triages Brain output the same way. */
export const BRIEFING_SEVERITY_ORDER: ReadonlyArray<BrainActivitySeverity> = [
  'critical',
  'high',
  'normal',
  'low',
] as const;

/**
 * A single activity as a briefing consumer sees it. It is a flat, honest
 * projection of ONE BrainActivity: the plain-language recommendation, its
 * severity/type/confidence, and — crucially — the full honesty payload
 * (evidence, missing evidence, alternatives, unknowns). Nothing is collapsed or
 * summarized away; a consumer that wants the full envelope can still follow
 * activityRef/assessmentRef back to the canonical record.
 */
export interface BriefingItem {
  /** The originating BrainActivity id, so a consumer can fetch the full record. */
  readonly activityRef: string;
  /** The subject/scope this item concerns (matches the activity's subject). */
  readonly subject: string;
  /** What kind of activity this is (diagnosis/recommendation/observation/alert/unknown). */
  readonly activityType: BrainActivityType;
  /** Triage severity, from the activity — never re-derived here. */
  readonly severity: BrainActivitySeverity;
  /** Visibility for the Trust layer, carried through unchanged. */
  readonly visibility: Visibility;
  /** When the Brain produced the underlying activity (point-in-time). */
  readonly timestamp: Date;
  /** Plain-language recommendation. Empty string when the Brain honestly
   * recommended nothing — preserved verbatim, never fabricated. */
  readonly recommendation: string;
  /** Overall confidence in the underlying activity, [0,1]. */
  readonly confidence: Confidence;
  /** The evidence the activity rested on, carried through unchanged. */
  readonly evidence: BrainActivity['evidence'];
  /** What the Brain still wishes it had. Never silently omitted. */
  readonly missingEvidence: ReadonlyArray<string>;
  /** Alternatives the Brain weighed but did not select. */
  readonly alternativesConsidered: ReadonlyArray<AlternativeExplanation>;
  /** Open questions that remain. */
  readonly unknowns: ReadonlyArray<string>;
  /** True when this activity is honestly inconclusive (type 'unknown', or no
   * recommendation with open unknowns). Surfaced, never hidden. */
  readonly inconclusive: boolean;
  /** Back-reference to the DiagnosticAssessment the activity came from, so a
   * consumer can trace provenance without the Brain leaking internals. */
  readonly assessmentRef: string;
}

/** All briefing items that share one subject, ordered by severity then time.
 * Present only when the underlying activities carry a subject. */
export interface BriefingSubjectGroup {
  /** The subject these items concern. */
  readonly subject: string;
  /** The most urgent severity present in this subject group, for quick triage. */
  readonly topSeverity: BrainActivitySeverity;
  /** Items for this subject, most urgent first. */
  readonly items: ReadonlyArray<BriefingItem>;
}

/** All briefing items that share one severity band, and — within it — grouped by
 * subject when subjects are present. Ordered by BRIEFING_SEVERITY_ORDER. */
export interface BriefingSeverityGroup {
  /** The severity band this group represents. */
  readonly severity: BrainActivitySeverity;
  /** Every item at this severity, ordered by time (stable). */
  readonly items: ReadonlyArray<BriefingItem>;
  /** The same items re-grouped by subject (subjects present only). */
  readonly subjects: ReadonlyArray<BriefingSubjectGroup>;
}

/**
 * The canonical, consumer-facing briefing shape. Every human-facing surface —
 * Daily Briefing, Employee workspace, Business-owner workspace, Notifications,
 * and future portals — reads THIS, and only this, to present the Brain's output.
 * It is a deterministic, read-only projection: given the same activities it is
 * byte-for-byte identical, and it fabricates nothing.
 */
export interface BrainBriefing {
  /** Total number of activities projected into this briefing. */
  readonly total: number;
  /** All items, globally ordered by severity (critical first) then time. This is
   * the "surface critical/high-priority items first" ordering consumers rely on. */
  readonly items: ReadonlyArray<BriefingItem>;
  /** Items grouped by severity band, ordered critical -> low. Severity bands with
   * no items are omitted, so a consumer iterates only what exists. */
  readonly bySeverity: ReadonlyArray<BriefingSeverityGroup>;
  /** Items grouped by subject (subjects present only), each ordered by severity
   * then time, and the groups themselves ordered by their top severity. */
  readonly bySubject: ReadonlyArray<BriefingSubjectGroup>;
  /** The subset of items that are honestly inconclusive/unknown, called out
   * explicitly so no consumer has to infer the Brain's uncertainty. */
  readonly inconclusive: ReadonlyArray<BriefingItem>;
  /** Count of critical + high items, the "needs attention now" headline number. */
  readonly urgentCount: number;
}

/** The inputs to the projection: the activities to summarize. Deterministic —
 * no clock, no RNG; ordering is derived purely from the activities themselves. */
export interface BriefingInputs {
  /** The BrainActivity records to project. Read-only; never mutated. */
  readonly activities: ReadonlyArray<BrainActivity>;
}

// ---------------------------------------------------------------------------
// Projection (pure).
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<BrainActivitySeverity, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** True when an activity is honestly inconclusive: the Brain published an
 * 'unknown' activity type, OR it made no recommendation yet still carries open
 * unknowns. This is a READ of what the Brain already said — it adds no judgment,
 * it only makes the Brain's stated uncertainty explicit for consumers. */
export function isInconclusiveActivity(activity: BrainActivity): boolean {
  if (activity.activityType === 'unknown') return true;
  if (activity.recommendation.length === 0 && activity.unknowns.length > 0) return true;
  return false;
}

/** Project one BrainActivity into a flat BriefingItem. Pure copy: every field is
 * carried through unchanged; nothing is fabricated or dropped. */
function toBriefingItem(activity: BrainActivity): BriefingItem {
  return {
    activityRef: activity.id,
    subject: activity.subject,
    activityType: activity.activityType,
    severity: activity.severity,
    visibility: activity.visibility,
    timestamp: activity.timestamp,
    recommendation: activity.recommendation,
    confidence: activity.confidence,
    evidence: activity.evidence,
    missingEvidence: activity.missingEvidence,
    alternativesConsidered: activity.alternativesConsidered,
    unknowns: activity.unknowns,
    inconclusive: isInconclusiveActivity(activity),
    assessmentRef: activity.assessmentRef,
  };
}

/** Deterministic comparator: most urgent severity first, then oldest-first by
 * timestamp, then by activityRef as a final stable tie-breaker so the ordering
 * is total and reproducible regardless of input order. */
function compareItems(a: BriefingItem, b: BriefingItem): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byTime = a.timestamp.getTime() - b.timestamp.getTime();
  if (byTime !== 0) return byTime;
  return a.activityRef < b.activityRef ? -1 : a.activityRef > b.activityRef ? 1 : 0;
}

/** Group items by subject (subjects present only), each group internally ordered
 * by the canonical comparator, and the groups ordered by their top severity then
 * subject name. Items whose subject is an empty string are excluded from subject
 * grouping (they still appear in the flat and severity views). */
function groupBySubject(items: ReadonlyArray<BriefingItem>): ReadonlyArray<BriefingSubjectGroup> {
  const bySubject = new Map<string, BriefingItem[]>();
  items.forEach((item) => {
    if (item.subject.length === 0) return;
    const bucket = bySubject.get(item.subject);
    if (bucket) bucket.push(item);
    else bySubject.set(item.subject, [item]);
  });
  const groups: BriefingSubjectGroup[] = [];
  bySubject.forEach((bucket, subject) => {
    const ordered = [...bucket].sort(compareItems);
    groups.push({
      subject,
      topSeverity: ordered[0]!.severity,
      items: ordered,
    });
  });
  groups.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.topSeverity] - SEVERITY_RANK[b.topSeverity];
    if (bySeverity !== 0) return bySeverity;
    return a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
  });
  return groups;
}

/**
 * Project a collection of BrainActivity records into a single, deterministic,
 * consumer-facing BrainBriefing. This is the ONLY shape any downstream surface
 * needs to read to present the Brain's output. It is a pure function: it copies,
 * orders, and groups activities the Brain already published; it makes NO new
 * decision, fabricates NO value, and hides NO uncertainty. The input array is
 * never mutated.
 */
export function projectBrainBriefing(inputs: BriefingInputs): BrainBriefing {
  const items = inputs.activities.map(toBriefingItem).sort(compareItems);

  // Group by severity, in canonical band order, omitting empty bands so a
  // consumer iterates only what exists.
  const bySeverity: BriefingSeverityGroup[] = [];
  BRIEFING_SEVERITY_ORDER.forEach((severity) => {
    const bandItems = items.filter((it) => it.severity === severity);
    if (bandItems.length === 0) return;
    bySeverity.push({
      severity,
      items: bandItems,
      subjects: groupBySubject(bandItems),
    });
  });

  const bySubject = groupBySubject(items);
  const inconclusive = items.filter((it) => it.inconclusive);
  const urgentCount = items.filter(
    (it) => it.severity === 'critical' || it.severity === 'high',
  ).length;

  return {
    total: items.length,
    items,
    bySeverity,
    bySubject,
    inconclusive,
    urgentCount,
  };
}

// ---------------------------------------------------------------------------
// Demonstration (pure, deterministic).
//
// Builds a small, fixed set of BrainActivity records by running the existing
// Observe -> Diagnose -> Recommend -> Publish flow (brain-activity.ts) on fixed
// metrics, then projects them into a BrainBriefing. Everything is deterministic:
// identity/time are passed in, so given the same inputs the briefing is
// byte-for-byte identical. It touches no DB, no CallGrid, no clock, no RNG, and
// is wired into no runtime path. It exists only to prove the projection composes.
// ---------------------------------------------------------------------------

/** Everything the demo produced, so a verification harness can assert on it. */
export interface BrainBriefingResult {
  /** The fixed activities that were projected. */
  readonly activities: ReadonlyArray<BrainActivity>;
  /** The resulting briefing. */
  readonly briefing: BrainBriefing;
}

/** Build a fixed, deterministic set of BrainActivity records for the demo by
 * running the published Brain flow on two contrasting windows: one with a
 * buyer-owned root cause (a real recommendation) and one with insufficient data
 * (an honest 'unknown'). Identity/time are caller-supplied for reproducibility. */
export function exampleBriefingActivities(): ReadonlyArray<BrainActivity> {
  // We reuse the canonical demo flow so the example activities are produced
  // exactly as the published Brain pipeline produces them.
  const scope = { organizationId: 'org_demo', locationId: 'loc_demo' } as const;

  // A buyer-root-cause window: enough calls, poor handling -> a real
  // recommendation at 'high'/'critical' severity.
  const buyer = demonstrateBrainActivityFlow({
    scope,
    subject: 'buyer:acme-insurance',
    metrics: {
      sampleSize: 60,
      answerRate: 30 / 54,
      noRouteRate: 6 / 60,
      buyerEndedRate: 24 / 30,
      callerEndedRate: 6 / 30,
      shortCallRate: 24 / 30,
      billableRate: 6 / 60,
      qualifiedRate: 6 / 60,
    },
    activityId: 'act_buyer_1',
    timestamp: new Date('2025-01-02T00:00:00.000Z'),
    windowRef: 'window_buyer_1',
  }).activity;

  // An insufficient-evidence window: too few calls -> honest 'unknown'.
  const unknown = demonstrateBrainActivityFlow({
    scope,
    subject: 'buyer:beacon-health',
    metrics: {
      sampleSize: 6,
      answerRate: 3 / 6,
    },
    activityId: 'act_unknown_1',
    timestamp: new Date('2025-01-01T00:00:00.000Z'),
    windowRef: 'window_unknown_1',
  }).activity;

  return [buyer, unknown];
}

/** Run the deterministic demo end-to-end: build the fixed activities, project a
 * briefing, and hand back both so callers/tests can inspect every stage. */
export function demonstrateBrainBriefing(): BrainBriefingResult {
  const activities = exampleBriefingActivities();
  const briefing = projectBrainBriefing({ activities });
  return { activities, briefing };
}
