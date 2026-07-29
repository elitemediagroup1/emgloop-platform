// The ONE way a finding is constructed.
//
// Extracted from the engine when anomaly and opportunity analysis arrived: three
// modules now emit findings, and three private constructors would have been three
// chances for one of them to forget its evidence, its rule version, or its
// limitations. `findingViolations()` checks the shape, but only for findings that
// were built — a second builder that quietly omits a field is exactly the kind of
// drift this repository has been bitten by before.
//
// It takes a minimal context rather than the engine's full input, so the analysis
// modules can depend on it without depending on each other.

import type {
  ActionSafety,
  AffectedEntity,
  CallGridEvidenceReference,
  CallGridFinding,
  FindingType,
  MetricClassification,
  Severity,
} from './callgrid-intelligence';

/** The canonical provider-report label for call-projection evidence. */
export const CALL_REPORT = 'CallGrid call reporting (MarketplaceCall projection)';

export interface EvidenceSpec {
  metricKey: string;
  entityType: CallGridEvidenceReference['entityType'];
  entityId?: string | null;
  entityName?: string | null;
  window: string;
  providerReport?: string;
  sourceType?: CallGridEvidenceReference['sourceType'];
  providerField?: string | null;
  rawValue?: number | null;
  normalizedValue?: number | null;
  derivedValue?: number | null;
  formula?: string | null;
  formulaVersion?: string | null;
  classification: MetricClassification;
  completeness?: number | null;
  notes?: string | null;
}

export interface FindingSpec {
  id: string;
  findingType: FindingType;
  title: string;
  plainLanguageSummary: string;
  classification: MetricClassification;
  severity: Severity;
  confidence: number;
  primaryMetric: string;
  currentValue?: number | null;
  comparisonValue?: number | null;
  absoluteChange?: number | null;
  percentageChange?: number | null;
  affectedEntities?: AffectedEntity[];
  drivers?: AffectedEntity[];
  evidence: EvidenceSpec[];
  limitations: string[];
  unknowns?: string[];
  recommendedReview?: string | null;
  recommendedActionType?: string | null;
  actionTarget?: string | null;
  actionSafety: ActionSafety;
  ruleId: string;
  ruleVersion: string;
}

/** Everything a finding needs about the period it was made in. */
export interface FindingContext {
  /** Injected clock — nothing here reads the system time. */
  now: Date;
  windowLabel: string;
  comparisonLabel: string | null;
}

export function buildEvidence(
  findingId: string,
  index: number,
  spec: EvidenceSpec,
): CallGridEvidenceReference {
  return {
    id: `${findingId}:e${index}`,
    findingId,
    sourceType: spec.sourceType ?? 'call_projection',
    providerReport: spec.providerReport ?? CALL_REPORT,
    metricKey: spec.metricKey,
    entityType: spec.entityType,
    entityId: spec.entityId ?? null,
    entityName: spec.entityName ?? null,
    window: spec.window,
    providerField: spec.providerField ?? null,
    rawValue: spec.rawValue ?? null,
    normalizedValue: spec.normalizedValue ?? null,
    derivedValue: spec.derivedValue ?? null,
    formula: spec.formula ?? null,
    formulaVersion: spec.formulaVersion ?? null,
    classification: spec.classification,
    completeness: spec.completeness ?? null,
    notes: spec.notes ?? null,
  };
}

export function buildFinding(spec: FindingSpec, ctx: FindingContext): CallGridFinding {
  return {
    id: spec.id,
    findingType: spec.findingType,
    title: spec.title,
    plainLanguageSummary: spec.plainLanguageSummary,
    classification: spec.classification,
    severity: spec.severity,
    confidence: spec.confidence,
    currentWindow: ctx.windowLabel,
    comparisonWindow: ctx.comparisonLabel,
    primaryMetric: spec.primaryMetric,
    currentValue: spec.currentValue ?? null,
    comparisonValue: spec.comparisonValue ?? null,
    absoluteChange: spec.absoluteChange ?? null,
    percentageChange: spec.percentageChange ?? null,
    affectedEntities: spec.affectedEntities ?? [],
    drivers: spec.drivers ?? [],
    supportingEvidence: spec.evidence.map((e, i) => buildEvidence(spec.id, i + 1, e)),
    limitations: spec.limitations,
    unknowns: spec.unknowns ?? [],
    recommendedReview: spec.recommendedReview ?? null,
    recommendedActionType: spec.recommendedActionType ?? null,
    actionTarget: spec.actionTarget ?? null,
    actionSafety: spec.actionSafety,
    createdAt: ctx.now.toISOString(),
    ruleId: spec.ruleId,
    ruleVersion: spec.ruleVersion,
  };
}
