// Evidence Engine — self-verification (pure, deterministic).
//
//   npx tsx packages/intelligence/src/evidence/verification.ts
//
// The claim under test is that this layer is DOMAIN-AGNOSTIC: Marketplace, CRM,
// Talent, Care and Web are meant to join by writing a contributor, with no
// change to the engine.
//
// Verifying that against the marketplace contributor alone would prove nothing
// — a layer written for one caller always fits that caller. So the checks below
// drive the engine with a SECOND, deliberately unrelated domain (a support-desk
// contributor that counts tickets, not calls) and exercise the properties the
// marketplace contributor cannot reach today: freshness, contradictions, and an
// unknown denominator.
//
// If a future domain needs a field this engine does not have, this file is
// where that failure should surface first.

import { assessEvidence, availableMetric, deriveConfidence, CONFIDENCE_CEILING } from './engine';
import type { EvidenceContributor, MetricObservation } from './types';

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`VERIFICATION FAILED: ${message}`);
}

/** A domain with no relationship to marketplaces, calls, or CallGrid. */
interface DeskInput {
  tickets: number;
  observations: MetricObservation[];
}

const deskContributor: EvidenceContributor<DeskInput> = {
  domain: 'support-desk',
  populationSize: (i) => i.tickets,
  scopeLabel: () => 'the current shift',
  staleAfterMs: 60 * 60 * 1000, // one hour
  emptyScopeReason: () =>
    'No tickets were opened during the current shift, so this metric has nothing to measure. Unknown is not zero.',
  observe: (i) => i.observations,
};

const source = (id: string) => [
  { sourceId: id, sourceLabel: id, derivation: 'COUNT over ticket rows', citation: null },
];

const observation = (over: Partial<MetricObservation> = {}): MetricObservation => ({
  metricId: 'resolution-time',
  label: 'Resolution time',
  observed: 80,
  total: 100,
  structurallyAbsent: null,
  provenance: source('desk-db'),
  ...over,
});

const NOW = '2026-07-19T12:00:00.000Z';

export function verifyEvidenceEngine(): { passed: true; checks: string[] } {
  const checks: string[] = [];

  // --- The engine carries no domain knowledge -----------------------------
  const desk = assessEvidence(deskContributor, { tickets: 100, observations: [observation()] }, NOW);
  assert(desk.domain === 'support-desk', 'the report is stamped with the contributing domain');
  assert(desk.metrics[0]!.domain === 'support-desk', 'every metric carries its domain');
  assert(desk.scopeLabel === 'the current shift', 'the domain names its own scope');
  checks.push('a non-marketplace domain drives the engine unmodified — the layer is domain-agnostic');

  // --- Coverage: a partial metric is USABLE, not withheld ------------------
  const partial = desk.metrics[0]!;
  assert(partial.coverage?.observed === 80 && partial.coverage.total === 100, 'coverage is carried, not flattened');
  assert(!partial.withheld, 'partial coverage does NOT withhold — a lower bound with its coverage attached is useful');
  assert(
    partial.missingProviderData.some((m) => m.includes('20 of 100')),
    'the uncovered remainder is named explicitly rather than silently absorbed',
  );
  checks.push('partial coverage stays available and states exactly what is missing');

  // --- An UNKNOWN denominator is null, never backfilled --------------------
  const noDenominator = assessEvidence(
    deskContributor,
    { tickets: 100, observations: [observation({ total: null })] },
    NOW,
  );
  assert(noDenominator.metrics[0]!.coverage === null, 'an unknown denominator yields null coverage, not observed/observed');
  assert(noDenominator.metrics[0]!.confidence === 0, 'confidence is zero when the denominator is unknown');
  checks.push('an unknown denominator stays null — completeness is never faked by defaulting total to observed');

  // --- Sample size gates confidence independently of coverage --------------
  const complete = (tickets: number) =>
    assessEvidence(
      deskContributor,
      { tickets, observations: [observation({ observed: tickets, total: tickets })] },
      NOW,
    ).metrics[0]!.confidence;
  assert(complete(3) < complete(50) && complete(50) < complete(500), 'more evidence supports more confidence');
  assert(complete(500) <= CONFIDENCE_CEILING, 'a single measurement never reaches certainty');
  checks.push('sample size moves confidence monotonically and never reaches certainty');

  // --- Freshness is SEPARATE from confidence -------------------------------
  const stale = assessEvidence(
    deskContributor,
    { tickets: 100, observations: [observation({ observed: 100, total: 100, sourceObservedAt: '2026-07-19T09:00:00.000Z' })] },
    NOW,
  ).metrics[0]!;
  assert(stale.freshness.ageMs === 3 * 60 * 60 * 1000, 'age is computed from the source timestamp');
  assert(stale.freshness.stale, 'three hours exceeds the one-hour policy');
  assert(stale.coverage?.observed === 100, 'the metric is still fully covered');
  assert(!stale.withheld, 'a stale metric is downgraded, not discarded — the operator decides');
  assert(stale.confidence < complete(100), 'staleness reduces confidence');
  checks.push('freshness is independent of coverage: a complete-but-stale metric is downgraded, not withheld');

  // --- An UNKNOWN age is never assumed fresh -------------------------------
  const noStamp = desk.metrics[0]!.freshness;
  assert(noStamp.ageMs === null && !noStamp.stale, 'no timestamp means no age');
  assert(noStamp.note !== null, 'and the engine SAYS so rather than implying freshness by silence');
  checks.push('an undeterminable age is stated, not silently treated as fresh');

  // --- Contradictions withhold, and outrank good coverage ------------------
  const conflictedReport = assessEvidence(
    deskContributor,
    {
      tickets: 100,
      observations: [
        observation({
          observed: 100,
          total: 100,
          contradictions: [
            {
              statement: 'Two sources report different resolution counts',
              betweenSources: ['desk-db', 'vendor-export'],
              detail: 'desk-db reports 100, vendor-export reports 74',
            },
          ],
        }),
      ],
    },
    NOW,
  );
  const conflicted = conflictedReport.metrics[0]!;
  assert(conflicted.withheld, 'a contradicted metric is withheld even at full coverage');
  assert(conflicted.withheldReason !== null, 'and the disagreement is stated, not merely flagged');
  assert(
    availableMetric(conflictedReport, 'resolution-time') === undefined,
    'withheld metrics are unreachable through the available lookup — a consumer cannot read one by accident',
  );
  checks.push('a contradiction withholds regardless of coverage — conflicting speech is worse than silence');

  // --- Nothing examined is UNKNOWN, never zero -----------------------------
  const empty = assessEvidence(deskContributor, { tickets: 0, observations: [observation()] }, NOW);
  assert(empty.available.length === 0, 'nothing is reasonable over an empty population');
  assert(
    empty.withheld[0]!.withheldReason?.includes('Unknown is not zero') === true,
    "and the reason says so in the domain's own words",
  );
  checks.push('an empty population withholds every measured metric — unknown is never zero');

  // --- A STRUCTURAL absence survives an empty population -------------------
  const absentOnEmpty = assessEvidence(
    deskContributor,
    {
      tickets: 0,
      observations: [
        observation({
          metricId: 'sentiment',
          total: null,
          structurallyAbsent: { reason: 'The desk records no sentiment field', unblockedBy: 'Add sentiment capture' },
        }),
      ],
    },
    NOW,
  ).metrics[0]!;
  assert(!absentOnEmpty.withheld, '"this field does not exist" is true whether zero or a million records were examined');
  assert(absentOnEmpty.confidence === CONFIDENCE_CEILING, 'a structural absence needs no sample, so it scores at the ceiling');
  assert(
    absentOnEmpty.missingProviderData.includes('Add sentiment capture'),
    'and what would unblock it is carried forward as missing provider data',
  );
  checks.push('a structural absence is knowable without a sample and is not withheld by an empty window');

  // --- Confidence is DERIVED, and its inputs are inspectable ---------------
  assert(
    deriveConfidence({ observed: 50, total: 100, sampleSize: 100, structurallyAbsent: false, stale: false, contradictionCount: 0 }) >
      deriveConfidence({ observed: 50, total: 100, sampleSize: 100, structurallyAbsent: false, stale: false, contradictionCount: 1 }),
    'a contradiction lowers confidence',
  );
  assert(
    deriveConfidence({ observed: 0, total: 0, sampleSize: 0, structurallyAbsent: false, stale: false, contradictionCount: 0 }) === 0,
    'no evidence yields no confidence',
  );
  checks.push('confidence is derived from stated inputs and can be audited rather than trusted');

  // --- Provenance is mandatory ---------------------------------------------
  assert(desk.metrics.every((m) => m.provenance.length > 0), 'every metric names where it came from');
  assert(desk.metrics.every((m) => m.provenance.every((p) => p.derivation.length > 0)), 'and how it was computed');
  checks.push('every metric carries provenance: source and derivation, never anonymous');

  return { passed: true, checks };
}

if (process.argv[1] && process.argv[1].includes('evidence/verification')) {
  try {
    const r = verifyEvidenceEngine();
    for (const c of r.checks) console.log(`  ✓ ${c}`);
    console.log(`\n${r.checks.length} Evidence Engine checks passed.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
