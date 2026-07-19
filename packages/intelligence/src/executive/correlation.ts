// Executive Brain — cross-sensor correlation.
//
// A single sensor sees one system. The value an executive cannot get from any
// dashboard is the JOIN: traffic rising while pipeline stalls is a bottleneck;
// call volume rising while attribution coverage drops is a measurement gap. This
// layer reasons across sensors.
//
// HONEST ABOUT WHAT IT IS. There is no LLM in this platform, so these are not
// emergent conclusions — they are deterministic, transparent rules. What makes
// them trustworthy rather than hardcoded assertions is that each rule fires ONLY
// when the observations it correlates ALREADY EXIST, and each already cleared the
// Evidence Engine. A correlation therefore cannot invent a signal; it can only
// connect two signals the sensors independently measured, and it carries both as
// its evidence. Its confidence is the weakest-link of the observations it joins,
// derived — never asserted — by buildObservation.
//
// Rules referencing a sensor that is not yet instrumented simply never fire (the
// observation they look for is absent). That is how the framework scales: a
// Calendar-vs-Email correlation can be written today and stay dormant until both
// sensors exist, with no fabricated output in the meantime.

import {
  buildObservation,
  type ExecutiveObservation,
  type ObservationEvidence,
  type ObservationRecommendation,
  type ObservationSeverity,
} from './observation';

/** A read-only view over the base observations a correlation rule reasons on. */
export interface ObservationLookup {
  all: readonly ExecutiveObservation[];
  /** A What-Changed observation for a metric, optionally constrained to a direction. */
  changeIn(domain: string, metricId: string, direction?: 'up' | 'down'): ExecutiveObservation | undefined;
  /** A risk observation citing a metric in a domain. */
  riskIn(domain: string, metricId: string): ExecutiveObservation | undefined;
}

function makeLookup(observations: readonly ExecutiveObservation[]): ObservationLookup {
  return {
    all: observations,
    changeIn(domain, metricId, direction) {
      return observations.find(
        (o) =>
          o.kind === 'change' &&
          o.change?.metricId === metricId &&
          o.source.domain === domain &&
          (direction === undefined || o.change.direction === direction),
      );
    },
    riskIn(domain, metricId) {
      return observations.find(
        (o) => o.kind === 'risk' && o.source.domain === domain && o.evidence.some((e) => e.metricId === metricId),
      );
    },
  };
}

/** What a fired correlation rule produces. */
export interface CorrelationMatch {
  observation: string;
  businessImpact: string;
  recommendation: ObservationRecommendation | null;
  severity: ObservationSeverity;
  owner: string | null;
  /** The observations this conclusion stands on — become its evidence. */
  from: readonly ExecutiveObservation[];
}

export interface CorrelationRule {
  id: string;
  label: string;
  affectedArea: string;
  /** Return a match, or null when the pattern does not hold. */
  detect(lookup: ObservationLookup): CorrelationMatch | null;
}

/**
 * The correlation rules that reason over the sensors instrumented today. Each
 * references only real metric ids; a rule whose sensors are not both present
 * simply returns null. Adding a rule is adding an entry here — no engine change.
 */
export const CORRELATION_RULES: readonly CorrelationRule[] = [
  {
    id: 'sales-bottleneck',
    label: 'Sales process bottleneck',
    affectedArea: 'Sales pipeline',
    detect(lookup) {
      const trafficUp = lookup.changeIn('website', 'website.sessions', 'up');
      const customersDown = lookup.changeIn('crm', 'crm.new_customers', 'down');
      if (!trafficUp || !customersDown) return null;
      return {
        observation:
          'Website traffic is rising while new customers created are falling — visitors are arriving but fewer are converting.',
        businessImpact:
          'Demand is up but conversion is not keeping pace, which points to a bottleneck between arrival and customer creation rather than a traffic-supply problem.',
        recommendation: {
          action: 'Review lead intake and follow-up for a capacity or process gap before spending more on traffic.',
          expectedImpact: 'Recovers conversion of the incremental traffic already being paid for.',
          owner: 'sales',
        },
        severity: 'high',
        owner: 'sales',
        from: [trafficUp, customersDown],
      };
    },
  },
  {
    id: 'lead-response-capacity',
    label: 'Lead response capacity risk',
    affectedArea: 'Sales operations',
    detect(lookup) {
      const callsUp = lookup.changeIn('marketplace', 'calls', 'up');
      const assignmentGap = lookup.riskIn('crm', 'crm.assigned');
      if (!callsUp || !assignmentGap) return null;
      return {
        observation:
          'Inbound call volume is rising while new customers are increasingly left unassigned — response capacity is not keeping up with demand.',
        businessImpact:
          'Unassigned records at rising volume mean slower response, which is where conversion and revenue leak first.',
        recommendation: {
          action: 'Add assignment capacity or automate routing before the backlog widens.',
          expectedImpact: 'Protects response time on the incremental volume.',
          owner: 'operations',
        },
        severity: 'high',
        owner: 'operations',
        from: [callsUp, assignmentGap],
      };
    },
  },
  {
    id: 'attribution-blind-spot',
    label: 'Attribution blind spot',
    affectedArea: 'Revenue measurement',
    detect(lookup) {
      const callsUp = lookup.changeIn('marketplace', 'calls', 'up');
      const attributionGap = lookup.riskIn('marketplace', 'buyers');
      if (!callsUp || !attributionGap) return null;
      return {
        observation:
          'Call volume is rising while a growing share of calls carries no buyer attribution — the marketplace is getting busier and harder to explain at the same time.',
        businessImpact:
          'Rising unattributed volume means per-buyer economics are computed on a shrinking, possibly non-representative slice.',
        recommendation: {
          action: 'Ask the provider why attribution is absent on these calls before trusting per-buyer figures.',
          expectedImpact: 'Restores confidence in per-buyer revenue as volume grows.',
          owner: 'platform',
        },
        severity: 'notable',
        owner: 'platform',
        from: [callsUp, attributionGap],
      };
    },
  },
];

/**
 * Run correlation rules over base observations. Pure; `timestamp` is injected.
 * Every returned observation cites the observations it correlated, so its
 * confidence is derived (weakest-link) and it can be audited to source.
 */
export function runCorrelations(
  observations: readonly ExecutiveObservation[],
  timestamp: string,
  rules: readonly CorrelationRule[] = CORRELATION_RULES,
): ExecutiveObservation[] {
  const lookup = makeLookup(observations);
  const out: ExecutiveObservation[] = [];

  for (const rule of rules) {
    const match = rule.detect(lookup);
    if (!match) continue;

    // The correlation's evidence is the evidence of everything it joins, plus a
    // pointer to each source observation so a reader can trace the whole chain.
    const evidence: ObservationEvidence[] = match.from.flatMap((o) =>
      o.evidence.map((e) => ({
        ...e,
        facts: [
          { statement: `From "${o.observation}"`, observed: Math.round(o.confidence * 100), denominator: 100, source: o.source.sensorLabel },
          ...e.facts,
        ],
      })),
    );
    if (evidence.length === 0) continue; // cannot correlate without evidence

    out.push(
      buildObservation({
        id: `correlation:${rule.id}`,
        kind: 'correlation',
        observation: match.observation,
        evidence,
        businessImpact: match.businessImpact,
        recommendation: match.recommendation,
        owner: match.owner,
        severity: match.severity,
        timestamp,
        source: { sensorId: 'executive-brain', sensorLabel: 'Executive Brain', domain: 'cross-sensor' },
        affectedArea: rule.affectedArea,
      }),
    );
  }

  return out;
}
