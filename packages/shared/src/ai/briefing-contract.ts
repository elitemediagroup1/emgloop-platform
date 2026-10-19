// The output contract of `loop.briefing.compose` (Loop Intelligence Phase G, 2026-09-26). Portable.
//
// A person's Briefing, composed from the artifacts Loop already holds for them -- their own domain digests,
// the organization readings they may open, the situations visible to them, their open work. The model
// ORDERS and SAYS; it discovers nothing. Every line cites SUPPLIED artifact refs, every number and date is
// in what it cites, no causal claims, no instructions to anyone, and no line invents a person.
//
// PURE.

import { aiDatesInText, aiHasQuotation, aiNumberSupported, aiNumbersInText, aiProseRejections, type AiOutputLengthIssue, type AiOutputRejection, type AiSupportedEvidence, type AiTaskDefinition, type AiTaskOutput } from './task';

export const BRIEFING_SCHEMA_ID = 'loop-briefing.v1';

export const BRIEFING_LINE_KINDS = ['NEEDS_YOU', 'CHANGED', 'WATCH', 'AHEAD', 'INSIGHT'] as const;
export type BriefingLineKind = (typeof BRIEFING_LINE_KINDS)[number];

export const BRIEFING_LIMITS = Object.freeze({ maxHeadlineChars: 160, maxLines: 6, maxLineChars: 240, maxCitations: 4, maxLimitations: 4 });

export interface AiBriefingLine {
  readonly kind: BriefingLineKind;
  readonly statement: string;
  readonly citations: readonly string[];
}

export interface AiBriefing {
  readonly headline: string;
  readonly lines: readonly AiBriefingLine[];
  readonly limitations: readonly string[];
}

export const BRIEFING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaId', 'headline', 'lines', 'limitations'],
  properties: {
    schemaId: { type: 'string', enum: [BRIEFING_SCHEMA_ID] },
    headline: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'statement', 'citations'],
        properties: { kind: { type: 'string', enum: [...BRIEFING_LINE_KINDS] }, statement: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } } },
      },
    },
    limitations: { type: 'array', items: { type: 'string' } },
  },
});

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parseBriefingOutput(value: unknown): AiTaskOutput | null {
  if (!isObject(value) || value.schemaId !== BRIEFING_SCHEMA_ID || Object.keys(value).length !== 4) return null;
  if (typeof value.headline !== 'string' || !Array.isArray(value.lines) || !Array.isArray(value.limitations) || !value.limitations.every((l) => typeof l === 'string')) return null;
  const lines: AiBriefingLine[] = [];
  for (const l of value.lines) {
    if (!isObject(l) || Object.keys(l).length !== 3 || typeof l.kind !== 'string' || typeof l.statement !== 'string' || !Array.isArray(l.citations) || !l.citations.every((c) => typeof c === 'string')) return null;
    lines.push({ kind: l.kind as BriefingLineKind, statement: l.statement, citations: l.citations as string[] });
  }
  const briefing: AiBriefing = { headline: value.headline, lines, limitations: value.limitations as string[] };
  return { schemaId: BRIEFING_SCHEMA_ID, summary: briefing.headline, claims: [], limitations: briefing.limitations, briefing };
}

/** Shares the validator's exact character/count rules, without returning any rejected prose. */
export function briefingOutputLengthIssues(output: AiTaskOutput): AiOutputLengthIssue[] {
  const b = output.briefing;
  if (!b) return [];
  const issues: AiOutputLengthIssue[] = [];
  const check = (field: AiOutputLengthIssue['field'], actual: number, maximum: number, index?: number) => {
    if (actual > maximum && issues.length < 8) issues.push({ field, ...(index === undefined ? {} : { index }), actual, maximum });
  };
  check('headline', [...b.headline].length, BRIEFING_LIMITS.maxHeadlineChars);
  check('lines', b.lines.length, BRIEFING_LIMITS.maxLines);
  check('limitations', b.limitations.length, BRIEFING_LIMITS.maxLimitations);
  b.lines.forEach((line, index) => {
    check('line.statement', [...line.statement].length, BRIEFING_LIMITS.maxLineChars, index);
    check('line.citations', line.citations.length, BRIEFING_LIMITS.maxCitations, index);
  });
  return issues;
}

const CAUSAL = /\b(because|caused|causes|due to|led to|resulted in|as a result|therefore|driven by|triggered)\b/i;

export function validateBriefingOutput(output: AiTaskOutput, task: AiTaskDefinition, suppliedRefs: ReadonlySet<string>, evidence: AiSupportedEvidence): AiOutputRejection[] {
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId || output.schemaId !== BRIEFING_SCHEMA_ID) out.push('WRONG_SCHEMA');
  const b = output.briefing;
  if (!b) return [...new Set([...out, 'EMPTY_ANSWER' as const])];
  if (b.headline.trim() === '') out.push('EMPTY_ANSWER');
  if (briefingOutputLengthIssues(output).length) out.push('ANSWER_TOO_LONG');
  const all = new Set<number>();
  for (const set of evidence.figures.values()) for (const n of set) all.add(n);
  for (const n of aiNumbersInText(b.headline)) if (!aiNumberSupported(n, all)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
  for (const line of b.lines) {
    if (!(BRIEFING_LINE_KINDS as readonly string[]).includes(line.kind)) out.push('WRONG_SCHEMA');
    if (line.statement.trim() === '') out.push('EMPTY_ANSWER');
    if (line.citations.length === 0) out.push('UNCITED_CLAIM');
    // Insights must connect supplied evidence, and remain explicitly conditional.
    if (line.kind === 'INSIGHT') {
      if (new Set(line.citations).size < 2 || !line.citations.some((r) => !r.startsWith('news:'))) out.push('UNCITED_CLAIM');
      if (!/\b(may|might|could|suggests|possible)\b/i.test(line.statement)) out.push('CAUSAL_OVERREACH');
    }
    const figures = new Set<number>();
    for (const ref of line.citations) {
      if (!suppliedRefs.has(ref)) out.push('CITATION_NOT_SUPPLIED');
      for (const n of evidence.figures.get(ref) ?? []) figures.add(n);
    }
    for (const n of aiNumbersInText(line.statement)) if (!aiNumberSupported(n, figures)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
    if (aiHasQuotation(line.statement)) out.push('VERBATIM_CONTENT');
  }
  const prose = [b.headline, ...b.lines.map((l) => l.statement)].join('\n');
  if (CAUSAL.test(prose)) out.push('CAUSAL_OVERREACH');
  for (const d of aiDatesInText(prose)) if (!evidence.dates.has(d)) out.push('UNSUPPORTED_DATE_IN_TEXT');
  out.push(...aiProseRejections(prose, task.consequence));
  return [...new Set(out)];
}
