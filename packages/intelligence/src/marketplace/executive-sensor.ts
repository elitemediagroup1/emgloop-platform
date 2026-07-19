// Marketplace → Executive Brain sensor adapter.
//
// This is the ONLY place marketplace vocabulary crosses into the Executive
// Brain. The Brain imports nothing from here; this file imports the Brain's
// sensor contract and translates a marketplace `EngineResult` into it. That
// direction is the neutrality guarantee: adding CRM or Calendar means writing a
// file like this one, and the Brain does not change.
//
// What it maps:
//   - Each MarketplaceFinding becomes a SensorFinding whose `citesMetricIds` are
//     the Evidence Engine metrics the finding's RULE required. Because a rule
//     only fired after those metrics cleared Layer 1, the Executive Brain can
//     derive the observation's confidence from THEM — not from the finding's own
//     `confidence.value`, which the rule authored. That is the defect this
//     milestone fixes: executive confidence now comes from the Evidence Engine.
//   - The finding's evidence rows ride along as drill-down facts (the raw counts
//     the executive view hides until expanded).
//
// It maps only findings whose rule it can identify. A finding it cannot link to
// a metric is passed through with empty `citesMetricIds`, which the Brain
// suppresses — better a visible suppression than an observation standing on
// evidence we could not name.

import type { ExecutiveSensor, SensorFinding } from '../executive/sensor';
import type { ObservationSeverity } from '../executive/observation';
import type { EngineResult } from './engine';
import { MARKETPLACE_RULES } from './engine';
import type { BusinessImpact, MarketplaceFinding } from './rule';
import { scoreFinding, type Severity } from './score';

/** Which Evidence Engine metrics each rule stands on. A fired finding shares its
 * rule's id (rules author `id: opts.id`), so this recovers the citation. */
const RULE_METRIC_IDS: ReadonlyMap<string, readonly string[]> = new Map(
  MARKETPLACE_RULES.map((r) => [r.id, r.requires.metrics]),
);

const SEVERITY_MAP: Record<Severity, ObservationSeverity> = {
  critical: 'critical',
  high: 'high',
  moderate: 'notable',
  low: 'notable',
  informational: 'informational',
};

/** A finding's business impact, stated for an executive — never a raw table. */
function impactText(impact: BusinessImpact): string | null {
  switch (impact.kind) {
    case 'measured':
      return impact.estimatedRevenueCents !== null
        ? `${impact.lostOpportunities.toLocaleString()} opportunity(ies) affected, an estimated ${(impact.estimatedRevenueCents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}.`
        : `${impact.lostOpportunities.toLocaleString()} opportunity(ies) affected. ${impact.basis}`;
    case 'volume-only':
      return `${impact.lostOpportunities.toLocaleString()} call(s) affected; value not yet priceable. ${impact.whyNotPriced}`;
    case 'unquantified':
      return impact.reason;
  }
}

function toSensorFinding(finding: MarketplaceFinding): SensorFinding {
  const cites = RULE_METRIC_IDS.get(finding.id) ?? [];
  const scored = scoreFinding(finding);

  return {
    id: finding.id,
    // Marketplace findings today are coverage risks and structural absences —
    // downside to head off. An actionable one is a risk; an unactionable one is
    // a neutral state-of-the-world observation for the summary.
    kind: finding.recommendedAction !== null ? 'risk' : 'observation',
    observation: finding.whatHappened,
    citesMetricIds: cites,
    businessImpact: impactText(finding.impact),
    recommendation: finding.recommendedAction
      ? {
          action: finding.recommendedAction,
          expectedImpact: finding.why,
          owner: finding.owner,
        }
      : null,
    owner: finding.owner,
    severity: SEVERITY_MAP[scored.severity],
    facts: finding.evidence.map((e) => ({
      statement: e.statement,
      observed: e.observed,
      denominator: e.denominator,
      source: e.source,
    })),
  };
}

/**
 * Build the Marketplace sensor from a marketplace intelligence run.
 *
 * The `EngineResult` already carries both halves the Brain needs: `evidence`
 * (the EvidenceReport, with available/withheld metrics and their derived
 * confidence) and `findings` (the reasoning over them). This adapter is pure —
 * it neither reads nor recomputes anything.
 */
export function marketplaceExecutiveSensor(engine: EngineResult): ExecutiveSensor {
  return {
    id: 'marketplace',
    label: 'Marketplace',
    instrumented: true,
    report: engine.evidence,
    findings: engine.findings.map(toSensorFinding),
  };
}
