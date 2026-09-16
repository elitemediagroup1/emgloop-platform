// What Case Explanation is allowed to send, assembled as the invoking person. Slice AI-5.
//
// DENY BY DEFAULT, AND LESS THAN THE READER CAN SEE. The Case page shows its reader a
// lot: names, notes, requests, who was asked for what. A model provider needs very
// little of it to explain what was measured. So this builder sends STRUCTURED FACTS
// ONLY, and every category it holds back is counted and named, so the answer and the
// operator both know the explanation was drawn from a subset.
//
// SENT (all OPERATIONAL, read under commercialIntelligence:view):
//   case:<id>                the Case's status, origin kind, producer, detection
//                            history, measured effect, uncertainty counts, the
//                            composition's own "not known" sentences, and the timeline
//                            as event types, times and actor kinds;
//   headline:<id>            the measured lineage: metric, values, change, coverage,
//                            comparison basis and window;
//   decision-evidence:<id>   each MEASURED evidence row (newest first, capped): metric,
//                            window, value, completeness, the producer's limitations
//                            and unknowns, rule, observation time -- and the entity as
//                            a pseudonymous label, never its name;
//   finding:<id>             a CURRENT finding produced by a deterministic rule: the
//                            claim, its evidence state and its structured reasoning;
//   monitoring:<id>          the watch's measured criteria and the derived verdict;
//   case-outcome:<id>        the recorded outcome and the measured effect.
//
// WITHHELD, always: anything a person typed (human-reported evidence, context notes,
// authorization notes, timeline notes and reasons, monitoring conditions and notes,
// human-authored findings), the Case title and subject (free text that can carry
// names), recommendations (this task explains; it does not advise), participation
// and work coordination (workforce data), every user identifier, entity names, and
// any evidence beyond the cap.
//
// EVERY BLOCK CARRIES its authority, why it was included, the permission it was read
// under, its sensitivity and its time basis -- the manifest the dossier and the UI
// show. The figures and dates each block contains are returned beside it, so an
// answer can be checked against exactly what was sent.
//
// ORGANIZATION FROM THE PRINCIPAL. The Case is read in the principal's organization;
// another organization's Case is simply not found.
//
// PURE apart from the one injected read.

import {
  AI_TASK_CASE_EXPLANATION,
  MEASURE_METRIC_DEFINITIONS,
  type AiContentTrustLevel,
  type AiContextItem,
  type AiContextPackage,
  type AiSupportedEvidence,
  type CaseEvidenceItem,
} from '@emgloop/shared';

import type { CaseWorkspaceView } from '../case-workspace.service';

/** The one read this builder needs. Production: CaseWorkspaceService, the page's own read. */
export interface CaseExplanationSource {
  case(organizationId: string, caseId: string, now: Date): Promise<CaseWorkspaceView | null>;
}

export const CASE_CONTEXT_MAX_EVIDENCE = 30;
const READ_UNDER = Object.freeze({ resource: 'commercialIntelligence', action: 'view' as const });

export interface CaseContextManifestEntry {
  readonly sourceRef: string;
  readonly authority: string;
  readonly why: string;
  readonly readUnder: { readonly resource: string; readonly action: 'view' };
  readonly sensitivity: 'OPERATIONAL';
  readonly trust: AiContentTrustLevel;
  readonly timeBasis: string;
}

export const CASE_CONTEXT_WITHHELD = [
  'HUMAN_REPORTED_EVIDENCE',
  'EVIDENCE_CONTEXT_NOTES',
  'EVIDENCE_BEYOND_CAP',
  'AUTHORIZATION_NOTE',
  'TIMELINE_NOTES_AND_REASONS',
  'CASE_TITLE_AND_SUBJECT',
  'HUMAN_AUTHORED_FINDING',
  'RECOMMENDATIONS',
  'PARTICIPATION_AND_WORK',
  'MONITORING_CONDITIONS_AND_NOTES',
  'USER_IDENTIFIERS',
  'ENTITY_NAMES',
] as const;
export type CaseContextWithheld = (typeof CASE_CONTEXT_WITHHELD)[number];

export interface CaseExplanationContext {
  readonly package: AiContextPackage;
  readonly evidence: AiSupportedEvidence;
  readonly manifest: readonly CaseContextManifestEntry[];
  /** What was held back and how much of it. Sent to the model too, as a count, never as content. */
  readonly withheld: Readonly<Partial<Record<CaseContextWithheld, number>>>;
  /** Pseudonym -> the real entity, for the operator's screen only. Never sent. */
  readonly entityAliases: Readonly<Record<string, { readonly entityType: string | null; readonly entityName: string | null }>>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Sorted keys, no whitespace: the same Case renders the same bytes every time. */
function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(value[k]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

type Unit = 'COUNT' | 'CENTS' | 'FRACTION' | 'MS' | 'VALUE';

function addFigure(set: Set<number>, value: number | null | undefined, unit: Unit): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const add = (n: number) => {
    set.add(n);
    set.add(Math.abs(n));
  };
  add(value);
  add(round(value, 2));
  add(round(value, 1));
  add(Math.round(value));
  if (unit === 'CENTS') {
    add(round(value / 100, 2));
    add(Math.round(value / 100));
  }
  if (unit === 'FRACTION') {
    add(round(value * 100, 2));
    add(round(value * 100, 1));
    add(Math.round(value * 100));
  }
  if (unit === 'MS') {
    add(Math.round(value / 1000));
    add(Math.round(value / 60_000));
    add(round(value / 3_600_000, 1));
  }
}

function day(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * A metric's unit, ONLY when Loop defines it. Headline metrics carry a governed unit
 * (MEASURE_METRIC_DEFINITIONS); a key that literally says cents is cents. Anything
 * else -- including provider metrics named `revenue`, whose unit no Loop contract
 * states -- is sent without a unit and without conversions, because labelling a
 * dollar figure as cents would make every explanation of it wrong by a factor of 100.
 */
function unitOf(metricKey: string | null, value?: number | null): Unit {
  const defined = metricKey ? (MEASURE_METRIC_DEFINITIONS as Record<string, { unit: string } | undefined>)[metricKey] : undefined;
  if (defined?.unit === 'CENTS') return 'CENTS';
  if (defined?.unit === 'RATIO') return 'FRACTION';
  if (defined?.unit === 'COUNT') return 'COUNT';
  if (/cents/i.test(metricKey ?? '')) return 'CENTS';
  if (/(^|[^a-z])completeness$|coverage$/i.test(metricKey ?? '') && typeof value === 'number' && Math.abs(value) <= 1) return 'FRACTION';
  return 'VALUE';
}

function unitLabel(metricKey: string | null, value?: number | null): string | null {
  const unit = unitOf(metricKey, value);
  return unit === 'CENTS' ? 'cents' : unit === 'FRACTION' ? 'fraction (0-1)' : unit === 'COUNT' ? 'count' : null;
}

export async function buildCaseExplanationContext(
  source: CaseExplanationSource,
  principal: { readonly organizationId: string; readonly userId: string },
  caseId: string,
  now: Date,
): Promise<CaseExplanationContext | null> {
  if (!principal.organizationId || !principal.userId || !caseId) return null;
  const view = await source.case(principal.organizationId, caseId, now);
  if (!view || view.caseId !== caseId) return null;

  const org = principal.organizationId;
  const items: AiContextItem[] = [];
  const manifest: CaseContextManifestEntry[] = [];
  const figures = new Map<string, Set<number>>();
  const dates = new Set<string>();
  const withheld: Partial<Record<CaseContextWithheld, number>> = {};
  const aliases: Record<string, { entityType: string | null; entityName: string | null }> = {};
  const count = (key: CaseContextWithheld, n = 1) => {
    if (n > 0) withheld[key] = (withheld[key] ?? 0) + n;
  };
  const noteDate = (...values: (string | Date | null | undefined)[]) => {
    for (const v of values) {
      const d = day(v);
      if (d) dates.add(d);
    }
  };

  const push = (
    sourceRef: string,
    trust: AiContentTrustLevel,
    authority: string,
    why: string,
    timeBasis: string,
    content: Json,
    numbers: Set<number>,
  ) => {
    items.push({
      blockId: `${org}::${sourceRef}`,
      kind: 'STRUCTURED',
      trust,
      sourceRef,
      content: stable(content),
      sensitivity: 'OPERATIONAL',
      readUnder: READ_UNDER,
    });
    manifest.push({ sourceRef, authority, why, readUnder: READ_UNDER, sensitivity: 'OPERATIONAL', trust, timeBasis });
    figures.set(sourceRef, numbers);
  };

  const brief = view.brief;
  const evidence = [...brief.evidence];
  const measured = evidence.filter((e) => e.evidenceClass === 'MEASURED');
  const humanReported = evidence.length - measured.length;
  count('HUMAN_REPORTED_EVIDENCE', humanReported);
  count('EVIDENCE_CONTEXT_NOTES', evidence.reduce((n, e) => n + (e.context?.length ?? 0), 0));
  if (brief.authorization?.note) count('AUTHORIZATION_NOTE');
  count('TIMELINE_NOTES_AND_REASONS', brief.timeline.filter((t) => t.note || t.reason).length);
  count('CASE_TITLE_AND_SUBJECT', (brief.title ? 1 : 0) + (brief.subject ? 1 : 0));
  if (view.recommendations) count('RECOMMENDATIONS', Math.max(1, view.recommendations.options?.length ?? 0));
  if (view.participation || view.coordination) {
    count('PARTICIPATION_AND_WORK', Math.max(1, (view.participation?.participants?.length ?? 0) + (view.coordination?.work?.length ?? 0)));
  }
  count(
    'USER_IDENTIFIERS',
    [brief.ownerUserId, brief.assigneeUserId, brief.authorization?.userId, ...brief.timeline.map((t) => t.actorUserId)].filter(Boolean).length,
  );

  // --- Evidence: measured rows only, newest first, capped, names pseudonymized ------
  const kept = measured
    .slice()
    .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)))
    .slice(0, CASE_CONTEXT_MAX_EVIDENCE);
  count('EVIDENCE_BEYOND_CAP', measured.length - kept.length);
  let aliasCounter = 0;
  const aliasFor = new Map<string, string>();
  const entityLabel = (e: CaseEvidenceItem): string | null => {
    if (!e.entityType && !e.entityId && !e.entityName) return null;
    const key = JSON.stringify([e.entityType, e.entityId, e.entityName]);
    let alias = aliasFor.get(key);
    if (!alias) {
      aliasCounter += 1;
      alias = `${(e.entityType ?? 'entity').replace(/[^A-Za-z_-]/g, '') || 'entity'} #${aliasCounter}`;
      aliasFor.set(key, alias);
      aliases[alias] = { entityType: e.entityType, entityName: e.entityName };
      if (e.entityName) count('ENTITY_NAMES');
    }
    return alias;
  };

  for (const e of kept) {
    const nums = new Set<number>();
    addFigure(nums, e.value, unitOf(e.metricKey, e.value));
    addFigure(nums, e.completeness, 'FRACTION');
    noteDate(e.observedAt);
    push(
      `decision-evidence:${e.id}`,
      /callgrid|provider/i.test(e.source) ? 'PROVIDER_REPORTED' : 'GOVERNED_FACT',
      `Decision evidence (${e.source})`,
      'A measured evidence row attached to this Case.',
      'observedAt: when the evidence describes the world',
      {
        type: 'measured-evidence',
        source: e.source,
        metricKey: e.metricKey,
        window: e.window,
        value: e.value,
        valueUnit: unitLabel(e.metricKey, e.value),
        completeness: e.completeness,
        entity: entityLabel(e),
        limitations: [...e.limitations],
        unknowns: [...e.unknowns],
        ruleId: e.ruleId,
        ruleVersion: e.ruleVersion,
        observedAt: e.observedAt,
      },
      nums,
    );
  }

  // --- Headline lineage -------------------------------------------------------------------
  if (brief.origin.kind === 'HEADLINE' && brief.origin.headline) {
    const hl = brief.origin.headline;
    const nums = new Set<number>();
    addFigure(nums, hl.currentValue, unitOf(hl.metric));
    addFigure(nums, hl.priorValue, unitOf(hl.metric));
    addFigure(nums, hl.percentageChange, 'FRACTION');
    addFigure(nums, hl.currentCoverage, 'FRACTION');
    noteDate(hl.currentWindowStart, hl.currentWindowEnd);
    push(
      `headline:${hl.headlineId}`,
      'GOVERNED_FACT',
      'Commercial Intelligence Headline',
      'The measured change that opened this Case.',
      'currentWindowStart..currentWindowEnd',
      {
        type: 'headline',
        metric: hl.metric,
        metricLabel: hl.metricLabel,
        valueUnit: unitLabel(hl.metric),
        againstObjective: hl.againstObjective,
        currentValue: hl.currentValue,
        priorValue: hl.priorValue,
        percentageChangeFraction: hl.percentageChange,
        currentCoverage: hl.currentCoverage,
        comparisonBasis: hl.comparisonBasis,
        currentWindowStart: hl.currentWindowStart,
        currentWindowEnd: hl.currentWindowEnd,
        dismissed: hl.dismissedAt !== null,
      },
      nums,
    );
  }

  // --- Finding: only a current, rule-produced claim ---------------------------------------
  if (view.finding) {
    const f = view.finding;
    if (f.generatedBy === 'DETERMINISTIC_RULE' && f.lifecycle === 'CURRENT') {
      const nums = new Set<number>();
      for (const c of f.reasoning.contradictory) for (const v of c.values) addFigure(nums, v, unitOf(c.metricKey, v));
      for (const s of f.supporting) {
        addFigure(nums, s.value, unitOf(s.metricKey, s.value));
        addFigure(nums, s.completeness, 'FRACTION');
      }
      noteDate(f.supportingWindowStart, f.supportingWindowEnd);
      push(
        `finding:${f.findingId}`,
        'GOVERNED_FACT',
        'Case Finding (deterministic rule)',
        'What Loop currently claims about this Case, and how established that claim is.',
        'supportingWindowStart..supportingWindowEnd',
        {
          type: 'finding',
          claim: f.claim,
          conclusion: f.conclusion,
          claimKind: f.claimKind,
          evidenceState: f.evidenceState,
          ruleVersion: f.ruleVersion,
          known: f.reasoning.known.map((k) => ({ text: k.text, evidence: k.evidenceId ? `decision-evidence:${k.evidenceId}` : null })),
          missing: [...f.reasoning.missing],
          contradictory: f.reasoning.contradictory.map((c) => ({
            metricKey: c.metricKey,
            window: c.window,
            values: [...c.values],
            evidence: c.evidenceIds.map((id) => `decision-evidence:${id}`),
          })),
          supportingWindowStart: f.supportingWindowStart,
          supportingWindowEnd: f.supportingWindowEnd,
        },
        nums,
      );
    } else if (f.generatedBy !== 'DETERMINISTIC_RULE') {
      count('HUMAN_AUTHORED_FINDING');
    }
  }

  // --- Monitoring: measured criteria and the derived verdict ------------------------------
  if (view.monitoring?.plan) {
    const m = view.monitoring;
    const plan = m.plan!;
    count('MONITORING_CONDITIONS_AND_NOTES', (plan.condition ? 1 : 0) + (plan.note ? 1 : 0));
    const measuredReading = m.assessment?.measured ?? null;
    const nums = new Set<number>();
    addFigure(nums, plan.baseline?.value, 'VALUE');
    addFigure(nums, plan.baseline?.denominator, 'COUNT');
    addFigure(nums, plan.success.threshold, 'VALUE');
    addFigure(nums, plan.failure.threshold, 'VALUE');
    addFigure(nums, plan.requires.minimumObservations, 'COUNT');
    addFigure(nums, plan.requires.minimumCoverage, 'FRACTION');
    addFigure(nums, measuredReading?.value, 'VALUE');
    addFigure(nums, measuredReading?.denominator, 'COUNT');
    addFigure(nums, measuredReading?.coverage, 'FRACTION');
    addFigure(nums, measuredReading?.observationCount, 'COUNT');
    noteDate(plan.observationStart, plan.observationEnd);
    push(
      `monitoring:${view.caseId}`,
      'GOVERNED_FACT',
      'Case monitoring (derived verdict)',
      'What is being watched after a decision, and how the observation window reads.',
      'observationStart..observationEnd; the verdict is derived as of the request',
      {
        type: 'monitoring',
        baseline: plan.baseline
          ? { metric: plan.baseline.metric, value: plan.baseline.value, unit: plan.baseline.unit, denominator: plan.baseline.denominator }
          : null,
        success: { metric: plan.success.metric, comparison: plan.success.comparison, threshold: plan.success.threshold },
        failure: { metric: plan.failure.metric, comparison: plan.failure.comparison, threshold: plan.failure.threshold },
        observationStart: plan.observationStart,
        observationEnd: plan.observationEnd,
        requires: {
          minimumObservations: plan.requires.minimumObservations,
          minimumCoverage: plan.requires.minimumCoverage,
          requiresCompleteWindow: plan.requires.requiresCompleteWindow,
        },
        verdict: m.assessment?.verdict ?? null,
        insufficiency: (m.assessment?.insufficiency ?? null) as Json,
        measured: measuredReading
          ? {
              metric: measuredReading.metric,
              value: measuredReading.value,
              unit: measuredReading.unit,
              denominator: measuredReading.denominator,
              coverage: measuredReading.coverage,
              observationCount: measuredReading.observationCount,
            }
          : null,
        explanation: [...(m.assessment?.explanation ?? [])],
        evidence: (m.assessment?.evidenceIds ?? []).map((id) => `decision-evidence:${id}`),
      },
      nums,
    );
  }

  // --- Outcome ------------------------------------------------------------------------------
  if (view.outcome?.outcome) {
    const o = view.outcome;
    const nums = new Set<number>();
    addFigure(nums, o.measuredEffectCents, 'CENTS');
    push(
      `case-outcome:${view.caseId}`,
      'GOVERNED_FACT',
      'Case outcome',
      'How the Case ended, and what could not be established about why.',
      'recorded outcome; no causal claim',
      {
        type: 'outcome',
        outcome: o.outcome,
        measuredEffectCents: o.measuredEffectCents,
        causalClaim: null,
        causalCaveat: o.causalCaveat,
        notEstablished: [...o.notEstablished],
      },
      nums,
    );
  }

  // --- The Case itself, written last so it can state what was sent and withheld ------------
  {
    const h = brief.history;
    const nums = new Set<number>();
    const counts = [h.detectionCount, h.timesReopened, brief.uncertainty.incompleteEvidenceCount, brief.uncertainty.completenessUnstatedCount, kept.length];
    for (const n of counts) addFigure(nums, n, 'COUNT');
    for (const n of Object.values(withheld)) addFigure(nums, n, 'COUNT');
    addFigure(nums, h.msToFirstDecision, 'MS');
    addFigure(nums, h.msToResolution, 'MS');
    addFigure(nums, brief.measuredEffectCents, 'CENTS');
    noteDate(h.firstDetectedAt, h.lastDetectedAt, ...brief.timeline.map((t) => t.occurredAt));
    push(
      `case:${view.caseId}`,
      'GOVERNED_FACT',
      'Operational Case (Decision Engine)',
      'The Case being explained: its state, detection history and what Loop could not establish.',
      'history instants are server-recorded; timeline entries carry occurredAt',
      {
        type: 'case',
        status: brief.status,
        origin: brief.origin.kind,
        producer: brief.sourceSystem,
        detection: {
          firstDetectedAt: iso(h.firstDetectedAt),
          lastDetectedAt: iso(h.lastDetectedAt),
          detectionCount: h.detectionCount,
          timesReopened: h.timesReopened,
          msToFirstDecision: h.msToFirstDecision,
          msToResolution: h.msToResolution,
        },
        outcome: brief.outcome,
        measuredEffectCents: brief.measuredEffectCents,
        measuredEffectUnit: 'cents',
        uncertainty: {
          incompleteEvidenceCount: brief.uncertainty.incompleteEvidenceCount,
          completenessUnstatedCount: brief.uncertainty.completenessUnstatedCount,
        },
        notKnown: [...view.notKnown],
        timeline: brief.timeline.map((t) => ({ type: t.type, occurredAt: t.occurredAt, actor: t.actorType, newState: t.newState })),
        evidenceRowsSent: kept.length,
        withheldFromThisExplanation: Object.fromEntries(Object.entries(withheld)) as { [key: string]: Json },
      },
      nums,
    );
  }

  const pkg: AiContextPackage = {
    organizationId: org,
    viewerUserId: principal.userId,
    taskId: AI_TASK_CASE_EXPLANATION.taskId,
    sensitivityCeiling: AI_TASK_CASE_EXPLANATION.sensitivityCeiling,
    // The Case block first, then the rest, so the model reads the subject before the detail.
    items: [...items.filter((i) => i.sourceRef.startsWith('case:')), ...items.filter((i) => !i.sourceRef.startsWith('case:'))],
  };
  return { package: pkg, evidence: { figures, dates }, manifest, withheld, entityAliases: aliases };
}
