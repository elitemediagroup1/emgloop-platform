// Marketplace — the first Evidence Engine contributor.
//
// This is the whole of what a domain must write. It states what was observed
// and where it came from; the platform derives coverage, confidence, freshness,
// contradictions and withholding uniformly.
//
// CRM, Talent, Care and Web join by writing a file this shape. Neither
// evidence/engine.ts nor evidence/types.ts changes to accommodate them — that
// is the test of the generalisation.

import type { EvidenceContributor, MetricObservation, Provenance } from '../evidence/types';
import type { MarketplaceCoverageReport } from '../coverage';

export interface MarketplaceEvidenceInput {
  coverage: MarketplaceCoverageReport;
}

/** Every marketplace metric traces to the canonical call projection. */
const canonicalSource = (citation: string | null, derivation: string): Provenance => ({
  sourceId: 'marketplace-call',
  sourceLabel: 'MarketplaceCall canonical projection',
  derivation,
  citation,
});

export const marketplaceEvidenceContributor: EvidenceContributor<MarketplaceEvidenceInput> = {
  domain: 'marketplace',

  populationSize: (input) => input.coverage.callsIngested,
  scopeLabel: (input) => input.coverage.windowLabel.toLowerCase(),

  // No freshness policy yet: the coverage report carries no source timestamp,
  // so declaring a staleness threshold would imply a check that cannot run.
  // Set this once the projection records when it last ingested.
  staleAfterMs: null,

  emptyScopeReason: (input) =>
    `No calls were ingested in ${input.coverage.windowLabel.toLowerCase()}, so this metric has nothing to measure. Unknown is not zero.`,

  observe(input): readonly MetricObservation[] {
    return input.coverage.capabilities.map((c) => ({
      metricId: c.id,
      label: c.label,
      observed: c.ratio?.observed ?? 0,
      total: c.ratio?.total ?? null,
      structurallyAbsent:
        c.status === 'unavailable' && c.tier !== 'not-populated'
          ? { reason: c.reason ?? `${c.label} has no source in Loop`, unblockedBy: c.unblockedBy }
          : null,
      provenance: [
        canonicalSource(
          c.citation,
          c.ratio
            ? `COUNT of MarketplaceCall rows in the window carrying ${c.label.toLowerCase()}`
            : `Capability catalogue: ${c.label} has no field on the canonical record`,
        ),
      ],
      unknowns: c.status === 'undetermined' ? [c.evidence] : [],
      // The coverage report has a single source, so it cannot disagree with
      // itself. Contradictions become reachable when a second source (the bid
      // reports) is ingested and can conflict with the call projection.
      contradictions: [],
      missingProviderData: [],
      sourceObservedAt: null,
    }));
  },
};
