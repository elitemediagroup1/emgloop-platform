// Executive Brain — self-verification (pure, deterministic).
//
//   npx tsx packages/intelligence/src/executive/verification.ts
//
// The mission names six properties the Executive Brain must have. Each is
// checked below against real Evidence Engine output, not mocked confidences:
//
//   1. Unknown never becomes zero.
//   2. Recommendations require evidence.
//   3. Confidence is derived from the Evidence Engine.
//   4. Contradictory evidence lowers confidence.
//   5. Empty datasets produce truthful summaries.
//   6. The Executive Brain never fabricates insights.
//
// Plus the architectural claim the milestone rests on — that the reasoning layer
// is PROVIDER-NEUTRAL. Marketplace is meant to be one sensor among future ones
// (CRM, Calendar, Email, …). Proving that against the marketplace sensor alone
// would prove nothing, so the checks drive the SAME `runExecutiveBrain` with two
// deliberately unrelated synthetic domains and with the real marketplace
// adapter, and assert both work with no change to the Brain.

import { assessEvidence, deriveConfidence } from '../evidence/engine';
import type {
  EvidenceContributor,
  EvidenceReport,
  MetricObservation,
  Provenance,
} from '../evidence/types';
import { assessMarketplaceCoverage } from '../coverage';
import { runMarketplaceIntelligence } from './../marketplace/engine';
import { marketplaceExecutiveSensor } from '../marketplace/executive-sensor';
import { runExecutiveBrain, type ExecutiveBrainReport } from './brain';
import { buildDomainSensor } from './domain-sensor';
import type { ExecutiveObservation } from './observation';
import { uninstrumentedSensor, type InstrumentedSensor, type SensorFinding } from './sensor';

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`VERIFICATION FAILED: ${message}`);
}

const NOW = new Date('2026-07-19T12:00:00.000Z');

// --- Synthetic domain plumbing (no marketplace vocabulary) -----------------

interface GenInput {
  population: number;
  observations: MetricObservation[];
}

function genContributor(domain: string): EvidenceContributor<GenInput> {
  return {
    domain,
    populationSize: (i) => i.population,
    scopeLabel: () => 'the test window',
    staleAfterMs: null,
    emptyScopeReason: () => `Nothing was examined in ${domain}, so this metric has nothing to measure. Unknown is not zero.`,
    observe: (i) => i.observations,
  };
}

const src = (id: string): Provenance[] => [
  { sourceId: id, sourceLabel: id, derivation: 'COUNT over rows', citation: null },
];

const metricObs = (over: Partial<MetricObservation> = {}): MetricObservation => ({
  metricId: 'x',
  label: 'Metric X',
  observed: 50,
  total: 100,
  structurallyAbsent: null,
  provenance: src('gen-db'),
  ...over,
});

function report(domain: string, input: GenInput): EvidenceReport {
  return assessEvidence(genContributor(domain), input, NOW.toISOString());
}

function sensor(id: string, label: string, rep: EvidenceReport, findings: SensorFinding[]): InstrumentedSensor {
  return { id, label, instrumented: true, report: rep, findings };
}

const finding = (over: Partial<SensorFinding> = {}): SensorFinding => ({
  id: 'f-x',
  kind: 'risk',
  observation: 'Metric X moved.',
  citesMetricIds: ['x'],
  businessImpact: null,
  recommendation: null,
  owner: null,
  severity: 'notable',
  ...over,
});

/** Every observation across a report, for universal invariant checks. */
function allObservations(r: ExecutiveBrainReport): ExecutiveObservation[] {
  return [...r.summary, ...r.risks, ...r.opportunities, ...r.recommendations];
}

export function verifyExecutiveBrain(): { passed: true; checks: string[] } {
  const checks: string[] = [];

  // --- 6. Never fabricates: every observation traces to an available metric --
  {
    const repA = report('crm', { population: 100, observations: [metricObs({ observed: 50, total: 100 })] });
    const repB = report('calendar', { population: 100, observations: [metricObs({ metricId: 'y', label: 'Metric Y', observed: 80, total: 100 })] });
    const sensors = [
      sensor('crm', 'CRM', repA, [finding()]),
      sensor('calendar', 'Calendar', repB, [finding({ id: 'f-y', citesMetricIds: ['y'], observation: 'Metric Y moved.' })]),
    ];
    const reportById = new Map(sensors.map((s) => [s.id, s.report]));
    const out = runExecutiveBrain(sensors, NOW);

    for (const o of allObservations(out)) {
      assert(o.evidence.length > 0, 'every observation carries at least one evidence citation');
      const rep = reportById.get(o.source.sensorId)!;
      const availableIds = new Set(rep.available.map((m) => m.metricId));
      for (const e of o.evidence) {
        assert(availableIds.has(e.metricId), `observation cites only AVAILABLE metrics (${e.metricId} was not available)`);
      }
    }
    checks.push('every observation traces to a metric that cleared the Evidence Engine — nothing is fabricated');
  }

  // --- 3. Confidence is DERIVED from the Evidence Engine ---------------------
  {
    // 50/100 over a sample of 100: deriveConfidence = 0.5 * 1 * 0.9 = 0.45.
    const engineConf = deriveConfidence({ observed: 50, total: 100, sampleSize: 100, structurallyAbsent: false, stale: false, contradictionCount: 0 });
    const rep = report('crm', { population: 100, observations: [metricObs({ observed: 50, total: 100 })] });
    const metricConf = rep.available.find((m) => m.metricId === 'x')!.confidence;
    assert(Math.abs(metricConf - engineConf) < 1e-9, 'the metric carries exactly the engine-derived confidence');

    const out = runExecutiveBrain([sensor('crm', 'CRM', rep, [finding()])], NOW);
    const obs = out.risks[0]!;
    assert(Math.abs(obs.confidence - metricConf) < 1e-9, 'the observation confidence EQUALS the Evidence Engine confidence, not an authored one');
    assert(Math.abs(obs.confidence - 0.9) > 1e-6, 'and it is genuinely derived — not the ceiling a rule might assert');
    checks.push('observation confidence is the Evidence Engine confidence of the cited metric, never asserted');
  }

  // --- 4. Contradictory evidence lowers confidence ---------------------------
  {
    // The mechanism, at the engine: a contradiction strictly reduces confidence.
    const withNo = deriveConfidence({ observed: 100, total: 100, sampleSize: 100, structurallyAbsent: false, stale: false, contradictionCount: 0 });
    const withOne = deriveConfidence({ observed: 100, total: 100, sampleSize: 100, structurallyAbsent: false, stale: false, contradictionCount: 1 });
    assert(withOne < withNo, 'a contradiction lowers the derived confidence at the engine level');

    // The consequence, at the Brain: a fully-covered metric yields a confident
    // observation; the SAME metric with a contradiction is withheld, so the
    // finding that leaned on it is suppressed — its executive confidence gone.
    const clean = report('crm', { population: 100, observations: [metricObs({ observed: 100, total: 100 })] });
    const cleanOut = runExecutiveBrain([sensor('crm', 'CRM', clean, [finding()])], NOW);
    assert(cleanOut.risks.length === 1 && cleanOut.risks[0]!.confidence > 0, 'clean evidence yields a confident observation');

    const conflicted = report('crm', {
      population: 100,
      observations: [
        metricObs({
          observed: 100,
          total: 100,
          contradictions: [{ statement: 'Two sources disagree on Metric X', betweenSources: ['gen-db', 'export'], detail: 'db=100, export=71' }],
        }),
      ],
    });
    const conflictedOut = runExecutiveBrain([sensor('crm', 'CRM', conflicted, [finding()])], NOW);
    assert(conflictedOut.risks.length === 0, 'a contradicted metric produces no observation — the confidence is removed, not merely reduced');
    assert(
      conflictedOut.suppressed.some((s) => /disagree/i.test(s.reason)),
      'and the suppression names the contradiction rather than hiding it',
    );
    checks.push('contradictory evidence lowers confidence: the engine discounts it and the Brain suppresses what leaned on it');
  }

  // --- 2. Recommendations require evidence -----------------------------------
  {
    const rep = report('crm', { population: 100, observations: [metricObs({ observed: 60, total: 100 })] });
    const withEvidence = finding({ id: 'rec-ok', citesMetricIds: ['x'], recommendation: { action: 'Do the thing', expectedImpact: 'Improves X', owner: 'ops' } });
    // A recommendation citing a metric that does not exist in the report.
    const withoutEvidence = finding({ id: 'rec-bad', citesMetricIds: ['nonexistent'], recommendation: { action: 'Act on nothing', expectedImpact: 'Unknowable', owner: 'ops' } });
    const out = runExecutiveBrain([sensor('crm', 'CRM', rep, [withEvidence, withoutEvidence])], NOW);

    assert(out.recommendations.every((o) => o.evidence.length > 0), 'every surfaced recommendation carries evidence');
    assert(out.recommendations.some((o) => o.id.endsWith('rec-ok')), 'the evidence-backed recommendation is surfaced');
    assert(!out.recommendations.some((o) => o.id.endsWith('rec-bad')), 'the evidence-less recommendation is NOT surfaced');
    assert(out.suppressed.some((s) => s.findingId === 'rec-bad'), 'and it is recorded as suppressed, not silently dropped');
    checks.push('a recommendation without available evidence is suppressed, never surfaced');
  }

  // --- 1. Unknown never becomes zero -----------------------------------------
  {
    // An instrumented sensor that examined nothing: metrics are withheld, not
    // reported as zero readings.
    const empty = report('crm', { population: 0, observations: [metricObs({ observed: 0, total: 100 })] });
    const out = runExecutiveBrain([sensor('crm', 'CRM', empty, [finding()])], NOW);

    assert(allObservations(out).length === 0, 'nothing is concluded from an empty population');
    const cov = out.evidenceCoverage.sensors[0]!;
    assert(cov.metricsAvailable === 0 && cov.metricsWithheld > 0, 'the metric is withheld, not presented as an available zero');
    assert(out.evidenceCoverage.overallConfidence === null, 'overall confidence is null when nothing was measured — not 0');
    assert(!allObservations(out).some((o) => o.confidence === 0), 'no observation carries a fabricated zero confidence');
    checks.push('an empty window withholds its metrics — unknown stays unknown, never a zero dressed as data');
  }

  // --- 5. Empty datasets produce truthful summaries --------------------------
  {
    const out = runExecutiveBrain([], NOW);
    assert(out.summary.length === 0 && out.risks.length === 0 && out.opportunities.length === 0 && out.recommendations.length === 0, 'no sensors means no observations — not an invented one');
    assert(out.systemHealth.band === 'unknown', 'system health is unknown, not healthy');
    assert(out.systemHealth.caveat !== null && /not a healthy score/i.test(out.systemHealth.caveat), 'and it says so plainly');
    assert(out.evidenceCoverage.overallConfidence === null, 'overall confidence is null over an empty platform');
    assert(out.generatedAt === NOW.toISOString(), 'the report is still stamped with the injected time');
    checks.push('an empty platform yields empty observation lists and an honest unknown posture — no fabrication');
  }

  // --- PROVIDER NEUTRALITY: two unrelated domains + the real marketplace -----
  {
    // Two deliberately unrelated synthetic domains through the same Brain.
    const crm = sensor('crm', 'CRM', report('crm', { population: 100, observations: [metricObs({ observed: 70, total: 100 })] }), [finding({ observation: 'A CRM metric slipped.' })]);
    const desk = sensor('support-desk', 'Support Desk', report('support-desk', { population: 100, observations: [metricObs({ metricId: 't', label: 'Ticket resolution', observed: 40, total: 100 })] }), [finding({ id: 'f-t', citesMetricIds: ['t'], observation: 'Ticket resolution fell.' })]);
    const out = runExecutiveBrain([crm, desk], NOW);
    const domains = new Set(allObservations(out).map((o) => o.source.domain));
    assert(domains.has('crm') && domains.has('support-desk'), 'unrelated domains both produce observations with no Brain change');

    // The real marketplace adapter, end to end, must satisfy the same invariants.
    const coverage = assessMarketplaceCoverage({ windowLabel: 'Last 7 days', callsIngested: 100, populated: { revenue: 60, payout: 100 } });
    const engine = runMarketplaceIntelligence({ coverage, measuredAt: NOW.toISOString() });
    const mpSensor = marketplaceExecutiveSensor(engine);
    assert(mpSensor.instrumented, 'the marketplace adapter yields an instrumented sensor');
    const mpOut = runExecutiveBrain([mpSensor], NOW);

    if (mpSensor.instrumented) {
      const availableIds = new Set(mpSensor.report.available.map((m) => m.metricId));
      for (const o of allObservations(mpOut)) {
        assert(o.confidence >= 0 && o.confidence <= 1, 'marketplace observation confidence is in [0,1]');
        for (const e of o.evidence) {
          assert(availableIds.has(e.metricId), 'marketplace observations trace only to available metrics — the adapter fabricates nothing');
        }
      }
    }
    assert(mpOut.evidenceCoverage.overallConfidence === null || (mpOut.evidenceCoverage.overallConfidence >= 0 && mpOut.evidenceCoverage.overallConfidence <= 1), 'marketplace overall confidence is null or in [0,1]');
    checks.push('the same Brain reasons over CRM, Support Desk and the real Marketplace adapter — the reasoning layer is provider-neutral');
  }

  // --- SPRINT 26: buildDomainSensor → What Changed + coverage gap -----------
  {
    const crm = buildDomainSensor({
      id: 'crm', label: 'CRM', domain: 'crm', scopeLabel: 'last 7 days',
      populationSize: 100, staleAfterMs: null,
      emptyScopeReason: 'No CRM records in the window. Unknown is not zero.',
      measuredAt: NOW.toISOString(), affectedArea: 'Sales pipeline',
      metrics: [
        { metricId: 'crm.new_customers', label: 'New customers', observed: 40, total: null, prior: 60, trackChange: true, provenance: src('crm-db') },
        { metricId: 'crm.assigned', label: 'Assigned conversations', observed: 30, total: 50, raiseCoverageGap: true, provenance: src('crm-db'), owner: 'operations' },
      ],
    });
    const out = runExecutiveBrain([crm], NOW);
    const changed = out.whatChanged.find((o) => o.change?.metricId === 'crm.new_customers');
    assert(!!changed, 'a two-window movement becomes a What-Changed observation');
    assert(changed!.change!.direction === 'down' && changed!.change!.prior === 60 && changed!.change!.current === 40, 'the change carries the real prior/current values');
    assert(changed!.confidence > 0 && changed!.evidence.length > 0, 'a change is evidence-backed with real confidence, not a bare delta');
    assert(changed!.affectedArea === 'Sales pipeline', 'the affected business area is carried for the Details panel');
    assert(out.risks.some((o) => o.evidence.some((e) => e.metricId === 'crm.assigned')), 'a partial-coverage metric raises a coverage-gap risk');
    checks.push('buildDomainSensor turns windowed counts into evidence-backed What-Changed and coverage-gap observations');
  }

  // --- SPRINT 26: a change is suppressed when its metric is withheld --------
  {
    const crmEmpty = buildDomainSensor({
      id: 'crm', label: 'CRM', domain: 'crm', scopeLabel: 'last 7 days',
      populationSize: 0, staleAfterMs: null,
      emptyScopeReason: 'No CRM records in the window. Unknown is not zero.',
      measuredAt: NOW.toISOString(),
      metrics: [{ metricId: 'crm.new_customers', label: 'New customers', observed: 0, total: null, prior: 60, trackChange: true, provenance: src('crm-db') }],
    });
    const out = runExecutiveBrain([crmEmpty], NOW);
    assert(out.whatChanged.length === 0, 'no change is claimed when the metric was withheld (empty window) — a delta is not evidence on its own');
    checks.push('a What-Changed claim is suppressed when its metric did not clear the Evidence Engine');
  }

  // --- SPRINT 26: cross-sensor correlation is evidence-gated ----------------
  {
    const website = buildDomainSensor({
      id: 'website', label: 'Website', domain: 'website', scopeLabel: 'last 7 days',
      populationSize: 500, staleAfterMs: null, emptyScopeReason: 'No website events.', measuredAt: NOW.toISOString(),
      metrics: [{ metricId: 'website.sessions', label: 'Sessions', observed: 500, total: null, prior: 300, trackChange: true, provenance: src('web-db') }],
    });
    const crm = buildDomainSensor({
      id: 'crm', label: 'CRM', domain: 'crm', scopeLabel: 'last 7 days',
      populationSize: 100, staleAfterMs: null, emptyScopeReason: 'No CRM records.', measuredAt: NOW.toISOString(),
      metrics: [{ metricId: 'crm.new_customers', label: 'New customers', observed: 40, total: null, prior: 60, trackChange: true, provenance: src('crm-db') }],
    });

    const out = runExecutiveBrain([website, crm], NOW);
    const corr = out.correlations.find((o) => o.id === 'correlation:sales-bottleneck');
    assert(!!corr, 'the correlation fires when BOTH underlying observations exist (traffic up + customers down)');
    assert(corr!.evidence.length >= 2, 'and it cites the observations it correlated as its evidence');
    assert(corr!.confidence > 0 && corr!.confidence <= 0.9, 'its confidence is derived (weakest-link) from the joined observations, in [0,1]');
    assert(corr!.source.domain === 'cross-sensor', 'a correlation is attributed to the cross-sensor reasoner, not a single sensor');

    const onlyWebsite = runExecutiveBrain([website], NOW);
    assert(
      !onlyWebsite.correlations.some((o) => o.id === 'correlation:sales-bottleneck'),
      'and it does NOT fire when only one side is present — a correlation cannot invent the signal it lacks',
    );
    checks.push('cross-sensor correlation fires only when both evidenced observations exist, and cites both');
  }

  // --- SPRINT 26: Evidence Coverage status is derived, never authored -------
  {
    const healthy = buildDomainSensor({
      id: 'crm', label: 'CRM', domain: 'crm', scopeLabel: 's', populationSize: 100, staleAfterMs: null,
      emptyScopeReason: 'x', measuredAt: NOW.toISOString(),
      metrics: [{ metricId: 'crm.new_customers', label: 'New customers', observed: 40, total: null, provenance: src('crm-db') }],
    });
    const connectedEmpty = buildDomainSensor({
      id: 'website', label: 'Website', domain: 'website', scopeLabel: 's', populationSize: 0, staleAfterMs: null,
      emptyScopeReason: 'x', measuredAt: NOW.toISOString(),
      metrics: [{ metricId: 'website.sessions', label: 'Sessions', observed: 0, total: null, provenance: src('web-db') }],
    });
    const missing = uninstrumentedSensor('gmail', 'Gmail', 'No inbound email ingestion exists.', 'A Gmail contributor.');

    const out = runExecutiveBrain([healthy, connectedEmpty, missing], NOW);
    const status = new Map(out.evidenceCoverage.sensors.map((s) => [s.sensorId, s.status]));
    assert(status.get('crm') === 'healthy', 'a sensor with fresh available metrics is healthy');
    assert(status.get('website') === 'connected', 'an instrumented sensor that examined nothing is connected — wired, not yet informative — never missing or healthy');
    assert(status.get('gmail') === 'missing', 'an uninstrumented sensor is missing');
    assert(
      out.evidenceCoverage.statusCounts.healthy === 1 &&
        out.evidenceCoverage.statusCounts.connected === 1 &&
        out.evidenceCoverage.statusCounts.missing === 1,
      'the coverage board tallies each posture',
    );
    checks.push('Evidence Coverage derives a connected/healthy/stale/missing status per sensor and tallies the board');
  }

  return { passed: true, checks };
}

if (process.argv[1] && process.argv[1].includes('executive/verification')) {
  try {
    const r = verifyExecutiveBrain();
    for (const c of r.checks) console.log(`  ✓ ${c}`);
    console.log(`\n${r.checks.length} Executive Brain checks passed.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
