// Conversational answers are distinct from proactive briefing cards. Pure, provider portable.
import {
  aiDatesInText,
  aiNumbersInText,
  type AiOutputRejection,
  type AiSupportedEvidence,
  type AiTaskDefinition,
  type AiTaskOutput,
} from './task';

export const LOOP_CHAT_SCHEMA_ID = 'loop-chat.v1';
export const LOOP_CHAT_LIMITS = Object.freeze({
  paragraphs: 16,
  paragraphChars: 1800,
  totalChars: 16000,
  calculations: 8,
  limitations: 8,
});
export type LoopChatMessage = { role: 'user' | 'assistant'; content: string };
export interface LoopChatParagraph {
  readonly kind: 'EVIDENCE' | 'REASONING' | 'CONVERSATION';
  readonly text: string;
  readonly citations: readonly string[];
}
export interface LoopChatCalculation {
  readonly operation: 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'DIVIDE' | 'PERCENT';
  readonly operands: readonly number[];
  readonly result: number;
  readonly citations: readonly string[];
}
export interface AiLoopChatAnswer {
  readonly paragraphs: readonly LoopChatParagraph[];
  readonly calculations: readonly LoopChatCalculation[];
  readonly limitations: readonly string[];
}
const refsSchema = { type: 'array', items: { type: 'string' } };
export const LOOP_CHAT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaId', 'paragraphs', 'calculations', 'limitations'],
  properties: {
    schemaId: { type: 'string', enum: [LOOP_CHAT_SCHEMA_ID] },
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'citations'],
        properties: {
          kind: { type: 'string', enum: ['EVIDENCE', 'REASONING', 'CONVERSATION'] },
          text: { type: 'string' },
          citations: refsSchema,
        },
      },
    },
    calculations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'operands', 'result', 'citations'],
        properties: {
          operation: { type: 'string', enum: ['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'PERCENT'] },
          operands: { type: 'array', items: { type: 'number' } },
          result: { type: 'number' },
          citations: refsSchema,
        },
      },
    },
    limitations: refsSchema,
  },
});
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const supported = (value: number, allowed: ReadonlySet<number>) =>
  [...allowed].some((n) => Math.abs(n - value) < 1e-9);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
export function parseLoopChatOutput(v: unknown): AiTaskOutput | null {
  if (
    !obj(v) ||
    v.schemaId !== LOOP_CHAT_SCHEMA_ID ||
    Object.keys(v).length !== 4 ||
    !Array.isArray(v.paragraphs) ||
    !Array.isArray(v.calculations) ||
    !strings(v.limitations)
  )
    return null;
  for (const p of v.paragraphs)
    if (
      !obj(p) ||
      Object.keys(p).length !== 3 ||
      !['EVIDENCE', 'REASONING', 'CONVERSATION'].includes(String(p.kind)) ||
      typeof p.text !== 'string' ||
      !strings(p.citations)
    )
      return null;
  for (const c of v.calculations)
    if (
      !obj(c) ||
      Object.keys(c).length !== 4 ||
      !['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'PERCENT'].includes(String(c.operation)) ||
      !Array.isArray(c.operands) ||
      !c.operands.every((x) => typeof x === 'number' && Number.isFinite(x)) ||
      typeof c.result !== 'number' ||
      !Number.isFinite(c.result) ||
      !strings(c.citations)
    )
      return null;
  const answer = {
    paragraphs: v.paragraphs,
    calculations: v.calculations,
    limitations: v.limitations,
  } as unknown as AiLoopChatAnswer;
  return {
    schemaId: LOOP_CHAT_SCHEMA_ID,
    summary: answer.paragraphs[0]?.text ?? '',
    claims: [],
    limitations: answer.limitations,
    chatAnswer: answer,
  };
}

/** Never executable expressions: a small arithmetic vocabulary, recomputed independently. */
export function loopChatCalculationValue(c: LoopChatCalculation): number | null {
  const [a, b] = c.operands;
  if (c.operands.length < 2 || c.operands.length > 8 || c.operands.some((n) => !Number.isFinite(n)))
    return null;
  let value: number;
  if (c.operation === 'ADD') value = c.operands.reduce((x, y) => x + y, 0);
  else if (c.operation === 'MULTIPLY') value = c.operands.reduce((x, y) => x * y, 1);
  else if (c.operands.length !== 2) return null;
  else if (c.operation === 'SUBTRACT') value = a! - b!;
  else if (b === 0) return null;
  else value = (a! / b!) * (c.operation === 'PERCENT' ? 100 : 1);
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Number.isFinite(rounded) ? rounded : null;
}

export function validateLoopChatOutput(
  output: AiTaskOutput,
  task: AiTaskDefinition,
  suppliedRefs: ReadonlySet<string>,
  evidence: AiSupportedEvidence,
): AiOutputRejection[] {
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== LOOP_CHAT_SCHEMA_ID || output.schemaId !== task.outputSchemaId)
    out.push('WRONG_SCHEMA');
  const a = output.chatAnswer;
  if (!a || !a.paragraphs.length) return [...out, 'EMPTY_ANSWER'];
  if (
    a.paragraphs.length > LOOP_CHAT_LIMITS.paragraphs ||
    a.calculations.length > LOOP_CHAT_LIMITS.calculations ||
    a.limitations.length > LOOP_CHAT_LIMITS.limitations ||
    [...a.paragraphs.map((p) => p.text), ...a.limitations].join('').length >
      LOOP_CHAT_LIMITS.totalChars ||
    a.limitations.some((l) => l.length > 1000)
  )
    out.push('ANSWER_TOO_LONG');
  const businessRef = (r: string) =>
    suppliedRefs.has(r) && !/^(user-request|conversation):/.test(r);
  const figures = (refs: readonly string[]) =>
    new Set(refs.flatMap((r) => [...(evidence.figures.get(r) ?? [])]));
  const checked: LoopChatCalculation[] = [];
  for (const c of a.calculations) {
    const expected = loopChatCalculationValue(c);
    const allowed = figures(c.citations);
    if (!c.citations.length || c.citations.length > 8 || c.citations.some((r) => !businessRef(r)))
      out.push('CITATION_NOT_SUPPLIED');
    if (
      expected === null ||
      Math.abs(expected - c.result) > 0.000001 ||
      c.operands.some((n) => !supported(n, allowed))
    )
      out.push('UNSUPPORTED_NUMBER_IN_TEXT');
    else checked.push(c);
  }
  for (const p of a.paragraphs) {
    if (p.kind !== 'CONVERSATION' && !p.citations.length) out.push('UNCITED_CLAIM');
    if (!p.text.trim()) out.push('EMPTY_ANSWER');
    if (p.text.length > LOOP_CHAT_LIMITS.paragraphChars || p.citations.length > 8)
      out.push('ANSWER_TOO_LONG');
    if (p.citations.some((r) => !businessRef(r))) out.push('CITATION_NOT_SUPPLIED');
    const allowed = figures(p.citations);
    for (const c of checked)
      if (c.citations.every((r) => p.citations.includes(r))) allowed.add(c.result);
    for (const n of aiNumbersInText(p.text))
      if (!supported(n, allowed)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
    for (const d of aiDatesInText(p.text))
      if (!evidence.dates.has(d)) out.push('UNSUPPORTED_DATE_IN_TEXT');
  }
  return [...new Set(out)];
}

/** Recent conversation is transient, untrusted context, never business evidence. */
export function boundedLoopChatMessages(value: unknown): LoopChatMessage[] {
  if (!Array.isArray(value)) return [];
  const valid = value
    .filter(
      (m): m is LoopChatMessage =>
        obj(m) &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        !!m.content.trim() &&
        m.content.length <= 16000,
    )
    .slice(-12);
  let remaining = 8000;
  const recent: LoopChatMessage[] = [];
  for (const m of valid.reverse()) {
    if (remaining <= 0) break;
    const content = m.content.slice(0, remaining);
    recent.push({ role: m.role, content });
    remaining -= content.length;
  }
  return recent.reverse();
}
