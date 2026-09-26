// The intelligence participation contract: what every Loop domain's reading must look like to take part
// in Loop Intelligence. Loop Intelligence PR 2 (the fabric), 2026-09-26.
//
// A DIGEST IS A READING OF EVIDENCE, IN LOOP'S TYPES. PR A defined the minimized digest body (topics,
// developments, synthesis ...). This file adds the typed layer every domain shares so that one reader
// (Home's projection, a future connective reader) can consume any domain without knowing it:
//
//   reading     the one-sentence reading of the subject, with a closed status (CALM / WATCH / ATTENTION)
//   signals     typed, closed-vocabulary facts and readings: a kind, a knowledge class, a bounded
//               statement, canonical entity references, evidence references and the instants involved
//   provenance  the governed sources read, each with its as-of and coverage; the producer's kind; the
//               contract version -- beside PR A's task/schema/producer versions and the fingerprint
//
// OBSERVED, MEASURED AND INFERRED ARE NEVER BLURRED.
//   OBSERVED  the evidence itself says it (a message stated a date; a record changed status).
//   MEASURED  Loop counted it from its own records, deterministically. Only a RULE producer may claim
//             it, and it must carry the metric it measured. A model can never MEASURE: its arithmetic
//             is a reading, and a reading presented as a measurement is a fabricated metric.
//   INFERRED  the producer's interpretation. Shown as a reading, always.
// Agreement between readers never upgrades INFERRED to OBSERVED (approved lock, 2026-09-25).
//
// BOUNDED AND CLOSED. Every string, list and nested object has a limit and a closed key set; an unknown
// key is refused, never ignored. Signals carry references, never content: an evidence ref names where
// the evidence lives, and an entity ref names the business thing, so nothing here can carry a quote.
//
// PURE. No clock, no I/O.

import { entityRefRefusal } from './entity-ref';
import { isIntelligenceCoverage, type IntelligenceCoverage } from './intelligence-coverage';

export const INTELLIGENCE_CONTRACT_VERSION = 'intelligence-contract.v1';

export const INTELLIGENCE_SIGNAL_KINDS = [
  'CHANGE',
  'ATTENTION',
  'OPPORTUNITY',
  'RISK',
  'OBLIGATION',
  'DECISION_PENDING',
  'UNRESOLVED',
  'STALLED',
  'QUIET',
  'UPCOMING',
  'OPERATIONAL',
  'RESOLVED',
] as const;
export type IntelligenceSignalKind = (typeof INTELLIGENCE_SIGNAL_KINDS)[number];

export const INTELLIGENCE_KNOWLEDGE = ['OBSERVED', 'MEASURED', 'INFERRED'] as const;
export type IntelligenceKnowledge = (typeof INTELLIGENCE_KNOWLEDGE)[number];

/** Who owes an OBLIGATION, relative to the reader of the digest. Only an OBLIGATION carries it. */
export const INTELLIGENCE_OWED_BY = ['VIEWER', 'COWORKER', 'COUNTERPARTY', 'UNKNOWN'] as const;
export type IntelligenceOwedBy = (typeof INTELLIGENCE_OWED_BY)[number];

export const INTELLIGENCE_ORDINAL = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type IntelligenceOrdinal = (typeof INTELLIGENCE_ORDINAL)[number];

export const INTELLIGENCE_READING_STATUS = ['CALM', 'WATCH', 'ATTENTION'] as const;
export type IntelligenceReadingStatus = (typeof INTELLIGENCE_READING_STATUS)[number];

/**
 * How a digest was produced. RULE: deterministic code over Loop records. MODEL: a governed AI task.
 * RULE_AND_MODEL: a rule reading (which may MEASURE) merged with a model reading (which never may -- its
 * output contract refuses MEASURED before the merge ever sees it).
 */
export const INTELLIGENCE_PRODUCER_KINDS = ['RULE', 'MODEL', 'RULE_AND_MODEL'] as const;
export type IntelligenceProducerKind = (typeof INTELLIGENCE_PRODUCER_KINDS)[number];

/** The units a MEASURED metric may be in. Money is integer minor units, never a float of dollars. */
export const INTELLIGENCE_METRIC_UNITS = ['count', 'minor_currency', 'percent', 'ratio', 'seconds'] as const;
export type IntelligenceMetricUnit = (typeof INTELLIGENCE_METRIC_UNITS)[number];

export const SIGNAL_STATEMENT_MAX_CHARS = 280;
export const SIGNALS_MAX_PER_DIGEST = 12;
export const SIGNAL_ENTITIES_MAX = 6;
export const SIGNAL_EVIDENCE_REFS_MAX = 4;
export const PROVENANCE_SOURCES_MAX = 8;

const SIGNAL_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const METRIC_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Where a piece of evidence lives: a Loop row id, a keyed subject, `kind:id`. Never content. */
export const EVIDENCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,255}$/;
/** A UTC instant, as ISO 8601 with a Z. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface IntelligenceMetric {
  readonly name: string;
  readonly value: number;
  readonly unit: IntelligenceMetricUnit;
  /** The comparison value Loop measured in the same unit (the prior window), when it has one. */
  readonly baseline?: number;
}

export interface IntelligenceSignal {
  /** Stable within the digest, so a later reading can say a signal RESOLVED. */
  readonly key: string;
  readonly kind: IntelligenceSignalKind;
  readonly knowledge: IntelligenceKnowledge;
  readonly statement: string;
  /** Canonical entity references (`entity-ref.ts`). */
  readonly entities?: readonly string[];
  /** Where the evidence for this signal lives. At least one: a signal with no evidence is not written. */
  readonly evidenceRefs: readonly string[];
  readonly occurredAt?: string;
  readonly dueAt?: string;
  readonly asOf?: string;
  readonly confidence?: IntelligenceOrdinal;
  readonly severity?: IntelligenceOrdinal;
  readonly owedBy?: IntelligenceOwedBy;
  /**
   * Who appears to owe an OBLIGATION, as the SOURCE labels them (a Telegram contact or group sender).
   * A label the evidence itself showed, never a Loop identity and never an assignment. Only with owedBy.
   */
  readonly party?: string;
  readonly metric?: IntelligenceMetric;
}

export interface IntelligenceReading {
  readonly statement: string;
  readonly status: IntelligenceReadingStatus;
  readonly confidence: IntelligenceOrdinal;
}

const SIGNAL_KEYS = ['key', 'kind', 'knowledge', 'statement', 'entities', 'evidenceRefs', 'occurredAt', 'dueAt', 'asOf', 'confidence', 'severity', 'owedBy', 'party', 'metric'];
/** The longest source label a signal's `party` may carry. */
export const SIGNAL_PARTY_MAX_CHARS = 60;
const METRIC_KEYS = ['name', 'value', 'unit', 'baseline'];
const READING_KEYS = ['statement', 'status', 'confidence'];

export const INTELLIGENCE_CONTRACT_REFUSALS = [
  'NOT_AN_OBJECT',
  'NOT_A_LIST',
  'UNKNOWN_KEY',
  'MISSING_FIELD',
  'WRONG_TYPE',
  'STRING_TOO_LONG',
  'EMPTY_STRING',
  'LIST_TOO_LONG',
  'UNKNOWN_VALUE',
  'BAD_KEY',
  'DUPLICATE_KEY',
  'BAD_INSTANT',
  'BAD_ENTITY_REF',
  'PRIVATE_ENTITY_REF',
  'PRIVATE_SOURCE',
  'BAD_EVIDENCE_REF',
  'NO_EVIDENCE',
  'OWED_BY_NOT_OBLIGATION',
  'MEASURED_WITHOUT_METRIC',
  'MEASURED_BY_MODEL',
  'METRIC_NOT_MEASURED',
  'BAD_METRIC',
] as const;
export type IntelligenceContractRefusal = (typeof INTELLIGENCE_CONTRACT_REFUSALS)[number];

/** Who is writing, which decides what they may claim. */
export interface IntelligenceWriteContext {
  readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
  /** Null when the writer did not say: it may then claim nothing MEASURED (fail closed). */
  readonly producerKind: IntelligenceProducerKind | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number, out: IntelligenceContractRefusal[]): void {
  if (typeof value !== 'string') return void out.push('WRONG_TYPE');
  if (value.trim() === '') out.push('EMPTY_STRING');
  if ([...value].length > max) out.push('STRING_TOO_LONG');
}

function oneOf(value: unknown, allowed: readonly string[], out: IntelligenceContractRefusal[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) out.push('UNKNOWN_VALUE');
}

function instant(value: unknown, out: IntelligenceContractRefusal[]): void {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value) || Number.isNaN(Date.parse(value))) out.push('BAD_INSTANT');
}

/** Everything wrong with a list of canonical entity references in this scope. */
export function entityRefListRefusals(value: unknown, max: number, scope: 'PRINCIPAL' | 'ORGANIZATION'): IntelligenceContractRefusal[] {
  if (!Array.isArray(value)) return ['NOT_A_LIST'];
  const out: IntelligenceContractRefusal[] = [];
  if (value.length > max) out.push('LIST_TOO_LONG');
  if (new Set(value).size !== value.length) out.push('DUPLICATE_KEY');
  for (const ref of value) {
    const refusal = entityRefRefusal(ref, scope);
    if (refusal === 'PRINCIPAL_ONLY_KIND') out.push('PRIVATE_ENTITY_REF');
    else if (refusal) out.push('BAD_ENTITY_REF');
  }
  return [...new Set(out)];
}

function metricRefusals(value: unknown, out: IntelligenceContractRefusal[]): void {
  if (!isPlainObject(value)) return void out.push('BAD_METRIC');
  for (const key of Object.keys(value)) if (!METRIC_KEYS.includes(key)) out.push('UNKNOWN_KEY');
  if (typeof value.name !== 'string' || !METRIC_NAME.test(value.name)) out.push('BAD_METRIC');
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) out.push('BAD_METRIC');
  if (value.baseline !== undefined && (typeof value.baseline !== 'number' || !Number.isFinite(value.baseline))) out.push('BAD_METRIC');
  oneOf(value.unit, INTELLIGENCE_METRIC_UNITS, out);
  if (value.unit === 'minor_currency' && (!Number.isInteger(value.value) || (value.baseline !== undefined && !Number.isInteger(value.baseline)))) out.push('BAD_METRIC');
}

/** Everything wrong with one signal. Empty means it may be stored. */
export function intelligenceSignalRefusals(signal: unknown, context: IntelligenceWriteContext): IntelligenceContractRefusal[] {
  if (!isPlainObject(signal)) return ['NOT_AN_OBJECT'];
  const out: IntelligenceContractRefusal[] = [];
  for (const key of Object.keys(signal)) if (!SIGNAL_KEYS.includes(key)) out.push('UNKNOWN_KEY');
  for (const key of ['key', 'kind', 'knowledge', 'statement', 'evidenceRefs']) if (signal[key] === undefined) out.push('MISSING_FIELD');
  if (signal.key !== undefined && (typeof signal.key !== 'string' || !SIGNAL_KEY.test(signal.key))) out.push('BAD_KEY');
  if (signal.kind !== undefined) oneOf(signal.kind, INTELLIGENCE_SIGNAL_KINDS, out);
  if (signal.knowledge !== undefined) oneOf(signal.knowledge, INTELLIGENCE_KNOWLEDGE, out);
  if (signal.statement !== undefined) bounded(signal.statement, SIGNAL_STATEMENT_MAX_CHARS, out);
  if (signal.entities !== undefined) out.push(...entityRefListRefusals(signal.entities, SIGNAL_ENTITIES_MAX, context.scope));
  if (signal.evidenceRefs !== undefined) {
    if (!Array.isArray(signal.evidenceRefs)) out.push('NOT_A_LIST');
    else {
      if (signal.evidenceRefs.length === 0) out.push('NO_EVIDENCE');
      if (signal.evidenceRefs.length > SIGNAL_EVIDENCE_REFS_MAX) out.push('LIST_TOO_LONG');
      for (const ref of signal.evidenceRefs) if (typeof ref !== 'string' || !EVIDENCE_REF_PATTERN.test(ref)) out.push('BAD_EVIDENCE_REF');
    }
  }
  for (const key of ['occurredAt', 'dueAt', 'asOf']) if (signal[key] !== undefined) instant(signal[key], out);
  if (signal.confidence !== undefined) oneOf(signal.confidence, INTELLIGENCE_ORDINAL, out);
  if (signal.severity !== undefined) oneOf(signal.severity, INTELLIGENCE_ORDINAL, out);
  if (signal.owedBy !== undefined) {
    oneOf(signal.owedBy, INTELLIGENCE_OWED_BY, out);
    if (signal.kind !== 'OBLIGATION') out.push('OWED_BY_NOT_OBLIGATION');
  }
  if (signal.party !== undefined) {
    bounded(signal.party, SIGNAL_PARTY_MAX_CHARS, out);
    if (signal.owedBy === undefined) out.push('OWED_BY_NOT_OBLIGATION');
  }
  if (signal.knowledge === 'MEASURED') {
    if (signal.metric === undefined) out.push('MEASURED_WITHOUT_METRIC');
    if (context.producerKind !== 'RULE' && context.producerKind !== 'RULE_AND_MODEL') out.push('MEASURED_BY_MODEL');
  }
  if (signal.metric !== undefined) {
    metricRefusals(signal.metric, out);
    if (signal.knowledge !== 'MEASURED') out.push('METRIC_NOT_MEASURED');
  }
  return [...new Set(out)];
}

/** Everything wrong with a digest's signal list. Keys must be unique within it. */
export function intelligenceSignalsRefusals(signals: unknown, context: IntelligenceWriteContext): IntelligenceContractRefusal[] {
  if (!Array.isArray(signals)) return ['NOT_A_LIST'];
  const out: IntelligenceContractRefusal[] = [];
  if (signals.length > SIGNALS_MAX_PER_DIGEST) out.push('LIST_TOO_LONG');
  const keys = signals.map((s) => (isPlainObject(s) ? s.key : undefined)).filter((k) => typeof k === 'string');
  if (new Set(keys).size !== keys.length) out.push('DUPLICATE_KEY');
  for (const signal of signals) out.push(...intelligenceSignalRefusals(signal, context));
  return [...new Set(out)];
}

export function intelligenceReadingRefusals(reading: unknown): IntelligenceContractRefusal[] {
  if (!isPlainObject(reading)) return ['NOT_AN_OBJECT'];
  const out: IntelligenceContractRefusal[] = [];
  for (const key of Object.keys(reading)) if (!READING_KEYS.includes(key)) out.push('UNKNOWN_KEY');
  for (const key of READING_KEYS) if (reading[key] === undefined) out.push('MISSING_FIELD');
  if (reading.statement !== undefined) bounded(reading.statement, SIGNAL_STATEMENT_MAX_CHARS, out);
  if (reading.status !== undefined) oneOf(reading.status, INTELLIGENCE_READING_STATUS, out);
  if (reading.confidence !== undefined) oneOf(reading.confidence, INTELLIGENCE_ORDINAL, out);
  return [...new Set(out)];
}

// --- Provenance: the governed sources a reading read ---------------------------------------------

/** One governed source a reading read, as of when, with what coverage. `sourceId` is a registry id. */
export interface IntelligenceSourceUse {
  readonly sourceId: string;
  readonly asOf: string;
  readonly coverage: IntelligenceCoverage;
}

const SOURCE_USE_KEYS = ['sourceId', 'asOf', 'coverage'];

/**
 * Everything wrong with a provenance's `sources` list. `sourceScope` names the scope each registered
 * source may feed (the source registry's), so an ORGANIZATION reading that names a private source is
 * refused here as well as by the repository's basis check.
 */
export function intelligenceSourceUseRefusals(
  sources: unknown,
  scope: 'PRINCIPAL' | 'ORGANIZATION',
  sourceScopes: (sourceId: string) => readonly ('PRINCIPAL' | 'ORGANIZATION')[] | null,
): IntelligenceContractRefusal[] {
  if (!Array.isArray(sources)) return ['NOT_A_LIST'];
  const out: IntelligenceContractRefusal[] = [];
  if (sources.length > PROVENANCE_SOURCES_MAX) out.push('LIST_TOO_LONG');
  for (const use of sources) {
    if (!isPlainObject(use)) {
      out.push('NOT_AN_OBJECT');
      continue;
    }
    for (const key of Object.keys(use)) if (!SOURCE_USE_KEYS.includes(key)) out.push('UNKNOWN_KEY');
    const scopes = typeof use.sourceId === 'string' ? sourceScopes(use.sourceId) : null;
    if (!scopes) out.push('UNKNOWN_VALUE');
    else if (!scopes.includes(scope)) out.push('PRIVATE_SOURCE');
    instant(use.asOf, out);
    if (!isIntelligenceCoverage(use.coverage)) out.push('UNKNOWN_VALUE');
  }
  return [...new Set(out)];
}

// --- Synthesis eligibility: who may read a digest into something larger --------------------------

/**
 * Who a later synthesis may carry a digest to, derived from its SCOPE and never stated by its producer.
 * A PRINCIPAL digest may only ever inform that same person's own synthesis; an ORGANIZATION digest may
 * inform anyone in the organization the domain's read authority admits.
 */
export type IntelligenceSynthesisEligibility = 'OWNER_ONLY' | 'ORGANIZATION';
export function intelligenceSynthesisEligibility(scope: 'PRINCIPAL' | 'ORGANIZATION'): IntelligenceSynthesisEligibility {
  return scope === 'ORGANIZATION' ? 'ORGANIZATION' : 'OWNER_ONLY';
}
