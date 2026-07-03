// @emgloop/brain — Brain Briefing verification harness (pure).
//
// Phase 1 (Briefing verification). PR #35 introduced a framework-free
// verification harness for the Brain Activity flow; PR #37 extended the same
// PROOF pattern to the Call-Handling Metrics Assembler; PR #38 introduced the
// Brain Briefing projection (brain-briefing.ts) that turns BrainActivity[] into
// a stable, consumer-facing BrainBriefing. This module extends the pattern once
// more to the Briefing: it builds a fixed set of REAL BrainActivity records
// (reusing the projection's own deterministic demo plus two hand-built
// activities published through the REAL publishBrainActivity function), runs
// the REAL projectBrainBriefing over them, and checks invariants with a tiny
// internal assert helper, returning a structured report.
//
// Consistent with PR #35/#37 and the repo's tooling (only 'typecheck'/'build'
// via turbo, no test runner — and none may be added), this is a set of PURE
// functions. It performs NO I/O, NO persistence, NO DB writes, touches NO
// CallGrid path, uses NO LLM, and is NOT wired into any runtime. It compiles as
// part of the normal typecheck/build (which the green preview proves); a caller
// or a future test runner may additionally invoke
// runBrainBriefingVerification() to execute the checks at runtime.

import type { Evidence } from './types';
import type { DiagnosticAssessment } from './diagnostics';
import type { RecommendationEnvelope } from './recommendation';
import type { BrainActivity, BrainBriefing, BriefingItem } from './brain-briefing';
import {
  publishBrainActivity,
} from './brain-activity';
import {
  exampleBriefingActivities,
  projectBrainBriefing,
} from './brain-briefing';

// ---------------------------------------------------------------------------
// Tiny, framework-free assertion helper (mirrors PR #35/#37's self-contained
// style). No test runner exists in this repo and none is introduced here.
// ---------------------------------------------------------------------------

/** One recorded check. */
export interface BriefingCheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** The result of one named scenario (a group of checks). */
export interface BriefingScenarioResult {
  scenario: string;
  checks: BriefingCheckResult[];
  passed: boolean;
}

/** The whole harness run. */
export interface BriefingVerificationReport {
  passed: boolean;
  total: number;
  failures: number;
  scenarios: BriefingScenarioResult[];
}

/** A minimal check recorder — the entire "framework". Pure: it only
 * accumulates results into its own array. */
class Checker {
  readonly checks: BriefingCheckResult[] = [];
  ok(name: string, condition: boolean, detail?: string): void {
    this.checks.push({ name, passed: condition, detail: condition ? undefined : detail ?? 'expected true' });
  }
  eq<T>(name: string, actual: T, expected: T): void {
    const passed = actual === expected;
    this.ok(name, passed, passed ? undefined : 'expected ' + String(expected) + ', got ' + String(actual));
  }
  same(name: string, actual: unknown, expected: unknown): void {
    // Reference equality — used to prove the projection carries evidentiary
    // arrays through UNCHANGED rather than copying/rebuilding them.
    this.ok(name, actual === expected, 'expected the same reference, got a different one');
  }
}

function finalize(scenario: string, c: Checker): BriefingScenarioResult {
  const passed = c.checks.every((x) => x.passed);
  return { scenario, checks: c.checks, passed };
}

// ---------------------------------------------------------------------------
// Deterministic fixtures.
//
// Two activities come from the Briefing's own demo (exampleBriefingActivities,
// PR #38): a buyer-root-cause 'high'-severity recommendation and an honest
// 'unknown'. Two more are hand-built here, published through the REAL
// publishBrainActivity function (brain-activity.ts, PR #31) from hand-crafted
// but fully-typed DiagnosticAssessment + RecommendationEnvelope objects, so the
// fixture set spans all four severity bands and exercises subject grouping
// (the critical fixture shares a subject with the buyer fixture).
// ---------------------------------------------------------------------------

const VERIFY_SCOPE = { organizationId: 'org_briefing_verify', locationId: 'loc_briefing_verify' } as const;

const CRITICAL_EVIDENCE: Evidence[] = [
  { kind: 'system', description: 'Billing webhook error rate was 100% for the window.' },
];

/** A hand-built 'critical' assessment: an EMG-internal billing outage. Shares
 * the buyer fixture's subject on purpose, to exercise subject grouping with
 * more than one item per subject. */
const CRITICAL_ASSESSMENT: DiagnosticAssessment = {
  organizationId: VERIFY_SCOPE.organizationId,
  locationId: VERIFY_SCOPE.locationId,
  subject: 'buyer:acme-insurance',
  observations: [],
  findings: [
    {
      subject: 'billing_webhook_outage',
      statement: 'Billing integration is down; no calls are being marked billable.',
      severity: 'critical',
      evidence: CRITICAL_EVIDENCE,
      confidence: 0.9,
      state: 'confirmed',
    },
  ],
  rootCauses: [
    {
      category: 'emg',
      hypothesis: 'EMG-internal billing webhook is failing.',
      rationale: 'Billing webhook error rate was 100% for the window.',
      evidence: CRITICAL_EVIDENCE,
      confidence: 0.85,
    },
  ],
  unknowns: [],
  missingEvidence: [],
  confidence: 0.85,
  state: 'inferred',
  assessedAt: new Date('2025-01-03T00:00:00.000Z'),
};

const CRITICAL_ENVELOPE: RecommendationEnvelope = {
  organizationId: VERIFY_SCOPE.organizationId,
  locationId: VERIFY_SCOPE.locationId,
  visibility: 'private',
  recommendation: 'Escalate the billing webhook outage immediately.',
  action: 'escalate',
  reason: 'Billing webhook failures are preventing any call from being marked billable.',
  rootCause: 'emg',
  trust: {
    confidence: 0.85,
    evidence: CRITICAL_EVIDENCE,
    missingEvidence: [],
    wouldIncreaseConfidenceWith: [],
  },
  alternativesConsidered: [],
  unknowns: [],
  suggestedAction: 'Page the on-call engineer for the billing webhook.',
  expectedOutcome: {
    statement: 'Restoring the webhook resumes accurate billable tracking.',
    metric: 'billable_rate',
  },
  risk: {
    level: 'high',
    description: 'Continued outage misclassifies billable calls.',
    costOfInaction: 'Revenue miscount and margin risk during the outage.',
  },
  businessImpact: 'Prevents billing/revenue miscount during the outage window.',
};

/** Published through the REAL publisher (brain-activity.ts), not hand-assembled
 * as a BrainActivity literal — so this fixture proves the projection against an
 * activity produced the same way production would produce one. */
export const CRITICAL_FIXTURE_ACTIVITY: BrainActivity = publishBrainActivity({
  assessment: CRITICAL_ASSESSMENT,
  envelope: CRITICAL_ENVELOPE,
  id: 'act_verify_critical',
  timestamp: new Date('2025-01-03T00:00:00.000Z'),
});

const NORMAL_EVIDENCE: Evidence[] = [
  { kind: 'interaction', description: 'Caller-ended-call rate exceeded the vendor-traffic threshold.' },
];

/** A hand-built 'normal' assessment: a mild vendor-traffic signal, on a THIRD
 * subject, so subject grouping has three distinct subjects to order. */
const NORMAL_ASSESSMENT: DiagnosticAssessment = {
  organizationId: VERIFY_SCOPE.organizationId,
  locationId: VERIFY_SCOPE.locationId,
  subject: 'vendor:globex-traffic',
  observations: [],
  findings: [
    {
      subject: 'caller_ended_rate',
      statement: 'Caller ended calls unusually often for this vendor.',
      severity: 'normal',
      evidence: NORMAL_EVIDENCE,
      confidence: 0.6,
      state: 'inferred',
    },
  ],
  rootCauses: [
    {
      category: 'vendor',
      hypothesis: 'Vendor traffic quality is mildly degraded.',
      rationale: '1 deterministic signal crossed threshold.',
      evidence: NORMAL_EVIDENCE,
      confidence: 0.55,
    },
  ],
  unknowns: [],
  missingEvidence: [],
  confidence: 0.55,
  state: 'inferred',
  assessedAt: new Date('2025-01-01T12:00:00.000Z'),
};

const NORMAL_ENVELOPE: RecommendationEnvelope = {
  organizationId: VERIFY_SCOPE.organizationId,
  locationId: VERIFY_SCOPE.locationId,
  visibility: 'private',
  recommendation: 'Monitor this vendor for continued caller-ended calls.',
  action: 'operational_recommendation',
  reason: 'Caller-ended-call rate for this vendor is above the normal band.',
  rootCause: 'vendor',
  trust: {
    confidence: 0.55,
    evidence: NORMAL_EVIDENCE,
    missingEvidence: [],
    wouldIncreaseConfidenceWith: [],
  },
  alternativesConsidered: [],
  unknowns: [],
  suggestedAction: 'Review the next window before escalating.',
  expectedOutcome: {
    statement: 'Continued monitoring confirms whether the signal persists.',
    metric: 'caller_ended_rate',
  },
  risk: {
    level: 'low',
    description: 'A single mild signal does not yet warrant escalation.',
    costOfInaction: 'A real vendor issue could go unnoticed one window longer.',
  },
  businessImpact: 'Low; early monitoring signal only.',
};

export const NORMAL_FIXTURE_ACTIVITY: BrainActivity = publishBrainActivity({
  assessment: NORMAL_ASSESSMENT,
  envelope: NORMAL_ENVELOPE,
  id: 'act_verify_normal',
  timestamp: new Date('2025-01-01T12:00:00.000Z'),
});

/** Assemble the fixed, deterministic fixture set: the Briefing's own demo pair
 * (buyer-root-cause 'high' + insufficient-evidence 'unknown', both 'low' or
 * 'high' severity) plus the two hand-built activities above ('critical' and
 * 'normal'), so all four severity bands are represented at least once and the
 * 'buyer:acme-insurance' subject carries two items (critical + high). */
export function buildVerificationActivities(): BrainActivity[] {
  const [buyerActivity, unknownActivity] = exampleBriefingActivities();
  return [buyerActivity!, unknownActivity!, CRITICAL_FIXTURE_ACTIVITY, NORMAL_FIXTURE_ACTIVITY];
}

// ---------------------------------------------------------------------------
// Scenario 1: BrainActivity records project into a BrainBriefing at all.
// ---------------------------------------------------------------------------

function verifyProjectsIntoBriefing(): BriefingScenarioResult {
  const c = new Checker();
  const activities = buildVerificationActivities();
  const briefing: BrainBriefing = projectBrainBriefing({ activities });

  c.eq('briefing.total equals activity count', briefing.total, activities.length);
  c.eq('briefing.items has one entry per activity', briefing.items.length, activities.length);
  c.ok('every activityRef is present among items', activities.every((a) => briefing.items.some((it) => it.activityRef === a.id)));

  return finalize('BrainActivity records project into BrainBriefing', c);
}

// ---------------------------------------------------------------------------
// Scenario 2: critical/high severity items sort before lower severity.
// ---------------------------------------------------------------------------

function verifySeverityOrderingGlobal(): BriefingScenarioResult {
  const c = new Checker();
  const activities = buildVerificationActivities();
  const briefing = projectBrainBriefing({ activities });
  const rank: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };

  c.eq('first item is critical', briefing.items[0]?.severity, 'critical');
  c.eq('second item is high', briefing.items[1]?.severity, 'high');
  let nonDecreasing = true;
  for (let i = 1; i < briefing.items.length; i += 1) {
    const prev = briefing.items[i - 1];
    const cur = briefing.items[i];
    if (prev && cur && rank[prev.severity]! > rank[cur.severity]!) nonDecreasing = false;
  }
  c.ok('severity rank never increases (never gets less urgent then more urgent later)', nonDecreasing);
  c.eq('urgentCount counts critical+high (2)', briefing.urgentCount, 2);

  return finalize('critical/high sort before lower severity', c);
}

// ---------------------------------------------------------------------------
// Scenario 3: items group correctly by severity.
// ---------------------------------------------------------------------------

function verifyGroupingBySeverity(): BriefingScenarioResult {
  const c = new Checker();
  const activities = buildVerificationActivities();
  const briefing = projectBrainBriefing({ activities });

  c.eq('four severity bands present (all non-empty)', briefing.bySeverity.length, 4);
  const bandOrder = briefing.bySeverity.map((g) => g.severity).join(',');
  c.eq('bands ordered critical,high,normal,low', bandOrder, 'critical,high,normal,low');
  briefing.bySeverity.forEach((group) => {
    c.ok('band "' + group.severity + '" items all share its severity', group.items.every((it) => it.severity === group.severity));
  });
  const criticalBand = briefing.bySeverity.find((g) => g.severity === 'critical');
  c.eq('critical band has exactly 1 item', criticalBand?.items.length, 1);

  return finalize('items group correctly by severity', c);
}

// ---------------------------------------------------------------------------
// Scenario 4: items group correctly by subject when a subject exists.
// ---------------------------------------------------------------------------

function verifyGroupingBySubject(): BriefingScenarioResult {
  const c = new Checker();
  const activities = buildVerificationActivities();
  const briefing = projectBrainBriefing({ activities });

  c.eq('three distinct subjects present', briefing.bySubject.length, 3);
  const acme = briefing.bySubject.find((g) => g.subject === 'buyer:acme-insurance');
  c.eq('acme-insurance subject has 2 items (critical + high)', acme?.items.length, 2);
  c.eq('acme-insurance topSeverity is critical', acme?.topSeverity, 'critical');
  c.ok('acme-insurance items are internally severity-ordered', (acme?.items[0]?.severity ?? '') === 'critical');
  const subjectOrder = briefing.bySubject.map((g) => g.subject).join('|');
  c.eq(
    'subject groups ordered by top severity (acme, then vendor:normal, then beacon:low)',
    subjectOrder,
    'buyer:acme-insurance|vendor:globex-traffic|buyer:beacon-health',
  );

  return finalize('items group correctly by subject', c);
}

// ---------------------------------------------------------------------------
// Scenario 5: unknown/inconclusive activities are surfaced explicitly.
// ---------------------------------------------------------------------------

function verifyInconclusiveSurfacedExplicitly(): BriefingScenarioResult {
  const c = new Checker();
  const activities = buildVerificationActivities();
  const briefing = projectBrainBriefing({ activities });

  c.eq('exactly one inconclusive item', briefing.inconclusive.length, 1);
  const inc = briefing.inconclusive[0];
  c.eq('the inconclusive item is flagged inconclusive', inc?.inconclusive, true);
  c.ok('every non-inconclusive item is NOT in the inconclusive list', briefing.items.filter((it) => !it.inconclusive).every((it) => !briefing.inconclusive.includes(it)));
  c.ok('the three non-unknown activities are not marked inconclusive', briefing.items.filter((it) => it.activityType !== 'unknown').every((it) => it.inconclusive === false));

  return finalize('unknown/inconclusive activities are surfaced explicitly', c);
}

// ---------------------------------------------------------------------------
// Scenario 6: evidence, confidence, missing evidence, alternatives, unknowns
// are preserved (verbatim — same references, nothing rebuilt or fabricated).
// ---------------------------------------------------------------------------

function verifyHonestyFieldsPreserved(): BriefingScenarioResult {
  const c = new Checker();
  const activity = CRITICAL_FIXTURE_ACTIVITY;
  const briefing = projectBrainBriefing({ activities: [activity] });
  const item = briefing.items[0] as BriefingItem;

  c.same('evidence preserved by reference', item.evidence, activity.evidence);
  c.eq('confidence preserved', item.confidence, activity.confidence);
  c.same('missingEvidence preserved by reference', item.missingEvidence, activity.missingEvidence);
  c.same('alternativesConsidered preserved by reference', item.alternativesConsidered, activity.alternativesConsidered);
  c.same('unknowns preserved by reference', item.unknowns, activity.unknowns);
  c.eq('recommendation text preserved verbatim', item.recommendation, activity.recommendation);
  c.eq('assessmentRef preserved', item.assessmentRef, activity.assessmentRef);

  return finalize('evidence/confidence/missing/alternatives/unknowns preserved', c);
}

// ---------------------------------------------------------------------------
// Scenario 7: the buyer-root-cause activity appears as an actionable item.
// ---------------------------------------------------------------------------

function verifyBuyerActivityIsActionable(): BriefingScenarioResult {
  const c = new Checker();
  const [buyerActivity] = exampleBriefingActivities();
  const activities = buildVerificationActivities();
  const briefing = projectBrainBriefing({ activities });
  const item = briefing.items.find((it) => it.activityRef === buyerActivity?.id);

  c.ok('buyer activity is present in the briefing', item !== undefined);
  c.eq('buyer item severity is high', item?.severity, 'high');
  c.ok('buyer item carries a non-empty recommendation (actionable)', (item?.recommendation.length ?? 0) > 0);
  c.eq('buyer item is not marked inconclusive', item?.inconclusive, false);
  c.eq('buyer item confidence is 0.8 (3 concordant signals)', item?.confidence, 0.8);

  return finalize('buyer-root-cause activity appears as an actionable item', c);
}

// ---------------------------------------------------------------------------
// Scenario 8: the insufficient-evidence/unknown activity appears in the
// inconclusive list (never silently dropped, never fabricated as actionable).
// ---------------------------------------------------------------------------

function verifyUnknownActivityInInconclusiveList(): BriefingScenarioResult {
  const c = new Checker();
  const [, unknownActivity] = exampleBriefingActivities();
  const activities = buildVerificationActivities();
  const briefing = projectBrainBriefing({ activities });
  const inItems = briefing.items.find((it) => it.activityRef === unknownActivity?.id);
  const inInconclusive = briefing.inconclusive.find((it) => it.activityRef === unknownActivity?.id);

  c.ok('unknown activity is present in the flat items view', inItems !== undefined);
  c.ok('unknown activity is present in the inconclusive list', inInconclusive !== undefined);
  c.eq('unknown item activityType is unknown', inItems?.activityType, 'unknown');
  c.eq('unknown item severity is low', inItems?.severity, 'low');

  return finalize('insufficient-evidence/unknown activity appears in the inconclusive list', c);
}

// ---------------------------------------------------------------------------
// Scenario 9: the projection is deterministic (same input -> same output;
// input order never affects the result, since ordering is derived purely from
// severity/time/id, not array position).
// ---------------------------------------------------------------------------

function verifyDeterministic(): BriefingScenarioResult {
  const c = new Checker();
  const activities = buildVerificationActivities();

  const first = projectBrainBriefing({ activities });
  const second = projectBrainBriefing({ activities });
  c.eq(
    'two runs over the same input produce identical JSON',
    JSON.stringify(first),
    JSON.stringify(second),
  );

  const shuffled = [activities[2]!, activities[0]!, activities[3]!, activities[1]!];
  const third = projectBrainBriefing({ activities: shuffled });
  c.eq(
    'shuffled input order yields the same item ordering',
    third.items.map((it) => it.activityRef).join(','),
    first.items.map((it) => it.activityRef).join(','),
  );
  c.eq(
    'shuffled input order yields identical JSON output',
    JSON.stringify(third),
    JSON.stringify(first),
  );

  return finalize('projection output is deterministic', c);
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/** Run every Brain Briefing verification scenario and return a structured
 * report. Pure and deterministic: no I/O, no clock (fixtures pin every
 * timestamp), no RNG. */
export function runBrainBriefingVerification(): BriefingVerificationReport {
  const scenarios: BriefingScenarioResult[] = [
    verifyProjectsIntoBriefing(),
    verifySeverityOrderingGlobal(),
    verifyGroupingBySeverity(),
    verifyGroupingBySubject(),
    verifyInconclusiveSurfacedExplicitly(),
    verifyHonestyFieldsPreserved(),
    verifyBuyerActivityIsActionable(),
    verifyUnknownActivityInInconclusiveList(),
    verifyDeterministic(),
  ];
  const all = scenarios.flatMap((s) => s.checks);
  const failures = all.filter((x) => !x.passed).length;
  return {
    passed: failures === 0,
    total: all.length,
    failures,
    scenarios,
  };
}
