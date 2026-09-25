// domain-reading.v1: the ONE generic, portable output contract for a domain reading. Loop Intelligence
// PR 2 (the fabric), 2026-09-26.
//
// Every domain that asks a model to read its governed context (Mail, Calendar, a CallGrid rollup, a
// creator portfolio ...) answers in this one shape: a typed reading, typed signals and limitations --
// the participation contract (`../intelligence-contract.ts`) as a model can produce it. One contract,
// registered once in AI_OUTPUT_CONTRACTS; a domain adds a task and a template, never a new answer shape.
//
// PORTABLE. The schema is in the structured-output subset both providers accept (no const, no bounds,
// every object closed, every property required, nullable as anyOf with null); a test holds it there.
// Everything the schema cannot say is enforced after the answer, here:
//   - every bound of the participation contract (statement length, list sizes, closed vocabularies);
//   - a MODEL can never state MEASURED (the schema's enum does not offer it, and the validator refuses it);
//   - every evidence ref a signal cites was SUPPLIED in the context package;
//   - every entity it names was SUPPLIED as a canonical reference (no invented identity);
//   - every number in a statement is in a source that statement cites, every date is in the evidence;
//   - no quotation marks, and no run of words copied from a supplied message when the producer supplied
//     them to check against;
//   - no numeric self-confidence; the reading itself does not tell anybody what to do.
// A reading that breaks any rule is rejected whole; there is no partial display.
//
// PURE.

import {
  INTELLIGENCE_ORDINAL,
  INTELLIGENCE_OWED_BY,
  INTELLIGENCE_READING_STATUS,
  INTELLIGENCE_SIGNAL_KINDS,
  SIGNAL_STATEMENT_MAX_CHARS,
  intelligenceReadingRefusals,
  intelligenceSignalsRefusals,
  type IntelligenceContractRefusal,
  type IntelligenceReading,
  type IntelligenceSignal,
} from '../intelligence-contract';
import {
  aiDatesInText,
  aiHasQuotation,
  aiNumberSupported,
  aiNumbersInText,
  aiProseRejections,
  aiVerbatimRuns,
  type AiOutputRejection,
  type AiSupportedEvidence,
  type AiTaskDefinition,
  type AiTaskOutput,
} from './task';

export const DOMAIN_READING_SCHEMA_ID = 'domain-reading.v1';

/** What a model may claim to know. MEASURED is Loop's alone (a RULE producer over its own records). */
export const DOMAIN_READING_MODEL_KNOWLEDGE = ['OBSERVED', 'INFERRED'] as const;

export const DOMAIN_READING_LIMITS = Object.freeze({ maxLimitations: 8, maxLimitationChars: SIGNAL_STATEMENT_MAX_CHARS });

export interface AiDomainReading {
  readonly reading: IntelligenceReading;
  readonly signals: readonly IntelligenceSignal[];
  readonly limitations: readonly string[];
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const ordinal = { type: 'string', enum: [...INTELLIGENCE_ORDINAL] };

/** The JSON schema a provider is handed. Portable (checked by a test against `aiPortableSchemaViolations`). */
export const DOMAIN_READING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaId', 'reading', 'signals', 'limitations'],
  properties: {
    schemaId: { type: 'string', enum: [DOMAIN_READING_SCHEMA_ID] },
    reading: {
      type: 'object',
      additionalProperties: false,
      required: ['statement', 'status', 'confidence'],
      properties: {
        statement: { type: 'string', description: 'One sentence: what matters in this domain now. No quotes.' },
        status: { type: 'string', enum: [...INTELLIGENCE_READING_STATUS] },
        confidence: ordinal,
      },
    },
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'kind', 'knowledge', 'statement', 'entities', 'evidenceRefs', 'occurredAt', 'dueAt', 'confidence', 'severity', 'owedBy'],
        properties: {
          key: { type: 'string', description: 'Stable lower-case id for this signal, e.g. buyer-concern.' },
          kind: { type: 'string', enum: [...INTELLIGENCE_SIGNAL_KINDS] },
          knowledge: { type: 'string', enum: [...DOMAIN_READING_MODEL_KNOWLEDGE] },
          statement: { type: 'string' },
          entities: { type: 'array', items: { type: 'string' }, description: 'Only entity references supplied in the context.' },
          evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Only source references supplied in the context.' },
          occurredAt: nullable({ type: 'string' }),
          dueAt: nullable({ type: 'string' }),
          confidence: ordinal,
          severity: ordinal,
          owedBy: nullable({ type: 'string', enum: [...INTELLIGENCE_OWED_BY] }),
        },
      },
    },
    limitations: { type: 'array', items: { type: 'string' } },
  },
});

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Shape only. Null when the answer is not a domain-reading.v1 answer. Nulls become absent fields. */
export function parseDomainReadingOutput(value: unknown): AiTaskOutput | null {
  if (!isObject(value) || value.schemaId !== DOMAIN_READING_SCHEMA_ID) return null;
  const r = value.reading;
  if (!isObject(r) || typeof r.statement !== 'string' || typeof r.status !== 'string' || typeof r.confidence !== 'string') return null;
  if (!Array.isArray(value.signals) || !Array.isArray(value.limitations) || !value.limitations.every((l) => typeof l === 'string')) return null;
  const signals: IntelligenceSignal[] = [];
  for (const raw of value.signals) {
    if (!isObject(raw)) return null;
    if (typeof raw.key !== 'string' || typeof raw.kind !== 'string' || typeof raw.knowledge !== 'string' || typeof raw.statement !== 'string') return null;
    if (!Array.isArray(raw.entities) || !Array.isArray(raw.evidenceRefs)) return null;
    if (!raw.entities.every((e) => typeof e === 'string') || !raw.evidenceRefs.every((e) => typeof e === 'string')) return null;
    const signal: Record<string, unknown> = {
      key: raw.key,
      kind: raw.kind,
      knowledge: raw.knowledge,
      statement: raw.statement,
      evidenceRefs: [...raw.evidenceRefs],
    };
    if (raw.entities.length > 0) signal.entities = [...raw.entities];
    for (const k of ['occurredAt', 'dueAt', 'owedBy'] as const) {
      if (raw[k] === null || raw[k] === undefined) continue;
      if (typeof raw[k] !== 'string') return null;
      signal[k] = raw[k];
    }
    for (const k of ['confidence', 'severity'] as const) {
      if (typeof raw[k] !== 'string') return null;
      signal[k] = raw[k];
    }
    signals.push(signal as unknown as IntelligenceSignal);
  }
  const reading: IntelligenceReading = { statement: r.statement, status: r.status as IntelligenceReading['status'], confidence: r.confidence as IntelligenceReading['confidence'] };
  const limitations = value.limitations as string[];
  return {
    schemaId: DOMAIN_READING_SCHEMA_ID,
    summary: reading.statement,
    claims: [],
    limitations,
    domainReading: { reading, signals, limitations },
  };
}

function mapRefusal(r: IntelligenceContractRefusal): AiOutputRejection {
  switch (r) {
    case 'STRING_TOO_LONG':
    case 'LIST_TOO_LONG':
      return 'ANSWER_TOO_LONG';
    case 'EMPTY_STRING':
      return 'EMPTY_ANSWER';
    case 'BAD_ENTITY_REF':
    case 'PRIVATE_ENTITY_REF':
      return 'ENTITY_NOT_SUPPLIED';
    case 'NO_EVIDENCE':
    case 'BAD_EVIDENCE_REF':
      return 'UNCITED_CLAIM';
    case 'BAD_INSTANT':
      return 'UNSUPPORTED_DATE_IN_TEXT';
    default:
      return 'WRONG_SCHEMA';
  }
}

/** Every rule a parsed domain reading breaks. Empty means Loop may store it as a MODEL reading. */
export function validateDomainReadingOutput(
  output: AiTaskOutput,
  task: AiTaskDefinition,
  suppliedRefs: ReadonlySet<string>,
  evidence: AiSupportedEvidence,
): AiOutputRejection[] {
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId || output.schemaId !== DOMAIN_READING_SCHEMA_ID) out.push('WRONG_SCHEMA');
  const dr = output.domainReading;
  if (!dr) return [...new Set([...out, 'EMPTY_ANSWER' as const])];
  if (output.draft !== undefined || output.claims.length > 0) out.push('WRONG_SCHEMA');

  out.push(...intelligenceReadingRefusals(dr.reading).map(mapRefusal));
  // A model is never a RULE producer: MEASURED is refused (MEASURED_BY_MODEL -> WRONG_SCHEMA).
  out.push(...intelligenceSignalsRefusals(dr.signals, { scope: 'PRINCIPAL', producerKind: 'MODEL' }).map(mapRefusal));
  if (dr.limitations.length > DOMAIN_READING_LIMITS.maxLimitations) out.push('ANSWER_TOO_LONG');
  for (const l of dr.limitations) {
    if (l.trim() === '') out.push('EMPTY_ANSWER');
    if ([...l].length > DOMAIN_READING_LIMITS.maxLimitationChars) out.push('ANSWER_TOO_LONG');
  }

  const allFigures = new Set<number>();
  for (const set of evidence.figures.values()) for (const n of set) allFigures.add(n);
  const entities = evidence.entityRefs ?? new Set<string>();
  const texts: string[] = [dr.reading.statement, ...dr.limitations];
  for (const signal of dr.signals) {
    texts.push(signal.statement);
    const cited = new Set<number>();
    for (const ref of signal.evidenceRefs ?? []) {
      if (!suppliedRefs.has(ref)) out.push('CITATION_NOT_SUPPLIED');
      for (const n of evidence.figures.get(ref) ?? []) cited.add(n);
    }
    for (const entity of signal.entities ?? []) if (!entities.has(entity)) out.push('ENTITY_NOT_SUPPLIED');
    for (const n of aiNumbersInText(signal.statement)) if (!aiNumberSupported(n, cited)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
    for (const at of [signal.occurredAt, signal.dueAt]) if (at && !evidence.dates.has(at.slice(0, 10))) out.push('UNSUPPORTED_DATE_IN_TEXT');
  }
  for (const text of [dr.reading.statement, ...dr.limitations]) {
    for (const n of aiNumbersInText(text)) if (!aiNumberSupported(n, allFigures)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
  }
  for (const date of aiDatesInText(texts.join('\n'))) if (!evidence.dates.has(date)) out.push('UNSUPPORTED_DATE_IN_TEXT');

  // No quote, ever; no copied run of words when the producer supplied the words to check against.
  const runs = evidence.verbatimRuns;
  for (const text of texts) {
    if (aiHasQuotation(text)) out.push('VERBATIM_CONTENT');
    if (runs && aiVerbatimRuns(text).some((run) => runs.has(run))) out.push('VERBATIM_CONTENT');
  }
  // The reading and its limitations never instruct; a signal may describe an obligation somebody holds.
  out.push(...aiProseRejections(texts.join('\n'), 'PROPOSES_FOR_APPROVAL'));
  out.push(...aiProseRejections([dr.reading.statement, ...dr.limitations].join('\n'), task.consequence));
  return [...new Set(out)];
}
