// The output contracts of situation synthesis and its independent verification. Loop Intelligence
// Phase F, 2026-09-26. Portable (both providers), and every rule the schema cannot say is enforced here.
//
// SYNTHESIS (`situation-synthesis.v1`). Given a deterministic cluster of signals from several domains and
// the open situations that might already be this one, the model answers NEW, UPDATE (naming one SUPPLIED
// situation) or NONE, with a title, a narrative and claims -- each claim citing SUPPLIED signal refs.
// Refused whole when: a returned situation id was not supplied; a claim cites nothing or cites a ref not
// supplied; a number or date is not in the cited evidence; a claim asserts CAUSATION (the evidence shows
// co-occurrence, never cause); a claim joins signals further apart in time than the window allows; a
// NEW duplicates a supplied open situation on the same references; or the prose instructs anyone.
//
// VERIFICATION (`situation-verification.v1`). A DIFFERENT provider (OTHER_THAN_SUBJECT) checks each claim
// against the same cited evidence: SUPPORTED, UNSUPPORTED or UNCLEAR. Agreement never converts an
// inference into a fact -- it records whether a second reader found the claim supported by the evidence.
//
// PURE.

import { SITUATION_TEMPORAL_WINDOW_DAYS } from '../situation';
import { aiDatesInText, aiHasQuotation, aiNumberSupported, aiNumbersInText, aiProseRejections, type AiOutputRejection, type AiSupportedEvidence, type AiTaskDefinition, type AiTaskOutput } from './task';

export const SITUATION_SYNTHESIS_SCHEMA_ID = 'situation-synthesis.v1';
export const SITUATION_VERIFICATION_SCHEMA_ID = 'situation-verification.v1';

export const SITUATION_DECISIONS = ['NEW', 'UPDATE', 'NONE'] as const;
export const SITUATION_CLAIM_KINDS = ['OBSERVATION', 'CONNECTION', 'IMPLICATION'] as const;
export const SITUATION_CLAIM_VERDICTS = ['SUPPORTED', 'UNSUPPORTED', 'UNCLEAR'] as const;

export const SITUATION_LIMITS = Object.freeze({ maxTitleChars: 120, maxNarrativeChars: 600, maxClaims: 8, maxClaimChars: 280, maxCitations: 6, maxLimitations: 6, maxLimitationChars: 200 });

export interface AiSituationClaim {
  readonly kind: (typeof SITUATION_CLAIM_KINDS)[number];
  readonly statement: string;
  readonly citations: readonly string[];
}

export interface AiSituationSynthesis {
  readonly decision: (typeof SITUATION_DECISIONS)[number];
  /** For UPDATE: one SUPPLIED situation id. Null otherwise. */
  readonly situationId: string | null;
  readonly title: string | null;
  readonly narrative: string | null;
  readonly claims: readonly AiSituationClaim[];
  readonly limitations: readonly string[];
}

export interface AiSituationVerification {
  readonly verdicts: readonly { readonly claimIndex: number; readonly verdict: (typeof SITUATION_CLAIM_VERDICTS)[number] }[];
  readonly limitations: readonly string[];
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const SITUATION_SYNTHESIS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaId', 'decision', 'situationId', 'title', 'narrative', 'claims', 'limitations'],
  properties: {
    schemaId: { type: 'string', enum: [SITUATION_SYNTHESIS_SCHEMA_ID] },
    decision: { type: 'string', enum: [...SITUATION_DECISIONS] },
    situationId: nullableString,
    title: nullableString,
    narrative: nullableString,
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'statement', 'citations'],
        properties: { kind: { type: 'string', enum: [...SITUATION_CLAIM_KINDS] }, statement: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } } },
      },
    },
    limitations: { type: 'array', items: { type: 'string' } },
  },
});

export const SITUATION_VERIFICATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaId', 'verdicts', 'limitations'],
  properties: {
    schemaId: { type: 'string', enum: [SITUATION_VERIFICATION_SCHEMA_ID] },
    verdicts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['claimIndex', 'verdict'], properties: { claimIndex: { type: 'integer' }, verdict: { type: 'string', enum: [...SITUATION_CLAIM_VERDICTS] } } },
    },
    limitations: { type: 'array', items: { type: 'string' } },
  },
});

/**
 * What the synthesis validator needs to know beyond the supplied refs: which situation ids were offered
 * (and their reference sets, for duplicate detection), when each cited signal happened, and the
 * references of this cluster.
 */
export interface SituationEvidence extends AiSupportedEvidence {
  readonly situations?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly signalTimes?: ReadonlyMap<string, number>;
  readonly clusterRefs?: ReadonlySet<string>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const strOrNull = (v: unknown) => v === null || typeof v === 'string';

export function parseSituationSynthesisOutput(value: unknown): AiTaskOutput | null {
  if (!isObject(value) || value.schemaId !== SITUATION_SYNTHESIS_SCHEMA_ID) return null;
  const keys = ['schemaId', 'decision', 'situationId', 'title', 'narrative', 'claims', 'limitations'];
  if (Object.keys(value).length !== keys.length || !keys.every((k) => k in value)) return null;
  if (typeof value.decision !== 'string' || !strOrNull(value.situationId) || !strOrNull(value.title) || !strOrNull(value.narrative)) return null;
  if (!Array.isArray(value.claims) || !Array.isArray(value.limitations) || !value.limitations.every((l) => typeof l === 'string')) return null;
  const claims: AiSituationClaim[] = [];
  for (const c of value.claims) {
    if (!isObject(c) || Object.keys(c).length !== 3 || typeof c.kind !== 'string' || typeof c.statement !== 'string' || !Array.isArray(c.citations) || !c.citations.every((x) => typeof x === 'string')) return null;
    claims.push({ kind: c.kind as AiSituationClaim['kind'], statement: c.statement, citations: c.citations as string[] });
  }
  const synthesis: AiSituationSynthesis = {
    decision: value.decision as AiSituationSynthesis['decision'],
    situationId: value.situationId as string | null,
    title: value.title as string | null,
    narrative: value.narrative as string | null,
    claims,
    limitations: value.limitations as string[],
  };
  return { schemaId: SITUATION_SYNTHESIS_SCHEMA_ID, summary: synthesis.narrative ?? '', claims: [], limitations: synthesis.limitations, situationSynthesis: synthesis };
}

/** Causal language the evidence never supports: co-occurrence is shown, cause never is. */
const CAUSAL = /\b(because|caused|causes|causing|due to|led to|leads to|resulted in|results in|as a result|therefore|driven by|drove|triggered)\b/i;

export function validateSituationSynthesisOutput(output: AiTaskOutput, task: AiTaskDefinition, suppliedRefs: ReadonlySet<string>, evidence: AiSupportedEvidence): AiOutputRejection[] {
  const e = evidence as SituationEvidence;
  const L = SITUATION_LIMITS;
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId || output.schemaId !== SITUATION_SYNTHESIS_SCHEMA_ID) out.push('WRONG_SCHEMA');
  const s = output.situationSynthesis;
  if (!s) return [...new Set([...out, 'EMPTY_ANSWER' as const])];
  if (!(SITUATION_DECISIONS as readonly string[]).includes(s.decision)) out.push('WRONG_SCHEMA');
  if (s.decision === 'NONE') {
    if (s.situationId !== null || s.claims.length > 0) out.push('WRONG_SCHEMA');
    return [...new Set(out)];
  }
  if (s.decision === 'UPDATE' ? s.situationId === null || !(e.situations?.has(s.situationId) ?? false) : s.situationId !== null) out.push('CITATION_NOT_SUPPLIED');
  const title = s.title?.trim() ?? '';
  const narrative = s.narrative?.trim() ?? '';
  if (title === '' || narrative === '') out.push('EMPTY_ANSWER');
  if ([...title].length > L.maxTitleChars || [...narrative].length > L.maxNarrativeChars) out.push('ANSWER_TOO_LONG');
  if (s.claims.length === 0) out.push('EMPTY_ANSWER');
  if (s.claims.length > L.maxClaims || s.limitations.length > L.maxLimitations) out.push('ANSWER_TOO_LONG');
  const allFigures = new Set<number>();
  for (const set of e.figures.values()) for (const n of set) allFigures.add(n);
  const citedAll = new Set<string>();
  for (const c of s.claims) {
    if (!(SITUATION_CLAIM_KINDS as readonly string[]).includes(c.kind)) out.push('WRONG_SCHEMA');
    if (c.statement.trim() === '') out.push('EMPTY_ANSWER');
    if ([...c.statement].length > L.maxClaimChars || c.citations.length > L.maxCitations) out.push('ANSWER_TOO_LONG');
    if (c.citations.length === 0) out.push('UNCITED_CLAIM');
    const figures = new Set<number>();
    for (const ref of c.citations) {
      if (!suppliedRefs.has(ref)) out.push('CITATION_NOT_SUPPLIED');
      citedAll.add(ref);
      for (const n of e.figures.get(ref) ?? []) figures.add(n);
    }
    for (const n of aiNumbersInText(c.statement)) if (!aiNumberSupported(n, figures)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
    if (CAUSAL.test(c.statement)) out.push('CAUSAL_OVERREACH');
    // Comparable windows: a claim may not join evidence further apart than the situation window.
    const times = c.citations.map((r) => e.signalTimes?.get(r)).filter((t): t is number => typeof t === 'number');
    if (times.length > 1 && Math.max(...times) - Math.min(...times) > SITUATION_TEMPORAL_WINDOW_DAYS * 86_400_000) out.push('TEMPORAL_MISMATCH');
  }
  for (const text of [title, narrative, ...s.limitations]) for (const n of aiNumbersInText(text)) if (!aiNumberSupported(n, allFigures)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
  if (CAUSAL.test(narrative) || CAUSAL.test(title)) out.push('CAUSAL_OVERREACH');
  for (const date of aiDatesInText([title, narrative, ...s.claims.map((c) => c.statement)].join('\n'))) if (!e.dates.has(date)) out.push('UNSUPPORTED_DATE_IN_TEXT');
  for (const text of [title, narrative, ...s.claims.map((c) => c.statement)]) if (aiHasQuotation(text)) out.push('VERBATIM_CONTENT');
  // Dedupe: a NEW situation on exactly the references of an open one supplied is that one.
  if (s.decision === 'NEW' && e.situations && e.clusterRefs) {
    for (const refs of e.situations.values()) {
      if (refs.size > 0 && [...refs].every((r) => e.clusterRefs!.has(r)) && [...e.clusterRefs].every((r) => refs.has(r))) out.push('DUPLICATE_SITUATION');
    }
  }
  out.push(...aiProseRejections([title, narrative, ...s.claims.map((c) => c.statement)].join('\n'), task.consequence));
  return [...new Set(out)];
}

export function parseSituationVerificationOutput(value: unknown): AiTaskOutput | null {
  if (!isObject(value) || value.schemaId !== SITUATION_VERIFICATION_SCHEMA_ID || !Array.isArray(value.verdicts) || !Array.isArray(value.limitations)) return null;
  if (Object.keys(value).length !== 3 || !value.limitations.every((l) => typeof l === 'string')) return null;
  const verdicts: AiSituationVerification['verdicts'][number][] = [];
  for (const v of value.verdicts) {
    if (!isObject(v) || Object.keys(v).length !== 2 || typeof v.claimIndex !== 'number' || typeof v.verdict !== 'string') return null;
    verdicts.push({ claimIndex: v.claimIndex, verdict: v.verdict as AiSituationVerification['verdicts'][number]['verdict'] });
  }
  return { schemaId: SITUATION_VERIFICATION_SCHEMA_ID, summary: 'verification', claims: [], limitations: value.limitations as string[], situationVerification: { verdicts, limitations: value.limitations as string[] } };
}

export function validateSituationVerificationOutput(output: AiTaskOutput, task: AiTaskDefinition, _refs: ReadonlySet<string>, evidence: AiSupportedEvidence): AiOutputRejection[] {
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId || output.schemaId !== SITUATION_VERIFICATION_SCHEMA_ID) out.push('WRONG_SCHEMA');
  const v = output.situationVerification;
  if (!v) return [...new Set([...out, 'EMPTY_ANSWER' as const])];
  const claimCount = (evidence as SituationEvidence & { claimCount?: number }).claimCount ?? 0;
  const seen = new Set<number>();
  for (const x of v.verdicts) {
    if (!Number.isInteger(x.claimIndex) || x.claimIndex < 0 || x.claimIndex >= claimCount || seen.has(x.claimIndex)) out.push('WRONG_SCHEMA');
    seen.add(x.claimIndex);
    if (!(SITUATION_CLAIM_VERDICTS as readonly string[]).includes(x.verdict)) out.push('WRONG_SCHEMA');
  }
  if (v.limitations.length > SITUATION_LIMITS.maxLimitations) out.push('ANSWER_TOO_LONG');
  return [...new Set(out)];
}
