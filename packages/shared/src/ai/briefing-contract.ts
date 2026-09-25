// The output contract of `loop.briefing.compose` (Loop Intelligence Phase G, 2026-09-26). Portable.
//
// A person's Briefing, composed from the artifacts Loop already holds for them -- their own domain digests,
// the organization readings they may open, the situations visible to them, their open work. The model
// ORDERS and SAYS; it discovers nothing. Every line cites SUPPLIED artifact refs, every number and date is
// in what it cites, no causal claims, no instructions to anyone, and no line invents a person.
//
// PURE.

import { aiDatesInText, aiHasQuotation, aiNumberSupported, aiNumbersInText, aiProseRejections, type AiOutputRejection, type AiSupportedEvidence, type AiTaskDefinition, type AiTaskOutput } from './task';

export const BRIEFING_SCHEMA_ID = 'loop-briefing.v1';

export const BRIEFING_LINE_KINDS = ['NEEDS_YOU', 'CHANGED', 'WATCH', 'AHEAD'] as const;
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

const CAUSAL = /\b(because|caused|causes|due to|led to|resulted in|as a result|therefore|driven by|triggered)\b/i;

export function validateBriefingOutput(output: AiTaskOutput, task: AiTaskDefinition, suppliedRefs: ReadonlySet<string>, evidence: AiSupportedEvidence): AiOutputRejection[] {
  const L = BRIEFING_LIMITS;
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId || output.schemaId !== BRIEFING_SCHEMA_ID) out.push('WRONG_SCHEMA');
  const b = output.briefing;
  if (!b) return [...new Set([...out, 'EMPTY_ANSWER' as const])];
  if (b.headline.trim() === '') out.push('EMPTY_ANSWER');
  if ([...b.headline].length > L.maxHeadlineChars || b.lines.length > L.maxLines || b.limitations.length > L.maxLimitations) out.push('ANSWER_TOO_LONG');
  const all = new Set<number>();
  for (const set of evidence.figures.values()) for (const n of set) all.add(n);
  for (const n of aiNumbersInText(b.headline)) if (!aiNumberSupported(n, all)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
  for (const line of b.lines) {
    if (!(BRIEFING_LINE_KINDS as readonly string[]).includes(line.kind)) out.push('WRONG_SCHEMA');
    if (line.statement.trim() === '') out.push('EMPTY_ANSWER');
    if ([...line.statement].length > L.maxLineChars || line.citations.length > L.maxCitations) out.push('ANSWER_TOO_LONG');
    if (line.citations.length === 0) out.push('UNCITED_CLAIM');
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
