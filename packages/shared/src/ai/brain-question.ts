// What a durable Brain job may ask a person, and what counts as an answer. Slice B5.
//
// Architecture: docs/architecture/brain-boundary.md §4, and the wait contract in
// brain-wait.ts.
//
// A QUESTION IS STRUCTURED, SMALL AND ANSWERABLE. "Brain found two companies named Acme.
// Which relationship did you mean?" is a CHOOSE_ONE with two options, each naming the
// governed record it stands for. The person answers by choosing; nothing they type can
// name a record the question did not offer. Free text is allowed only where a task
// declares it, and is bounded.
//
// NO AUTHORITY RIDES ON AN ANSWER. A reply is validated against the question it answers
// and carries nothing else: no organization, no principal, no role, no instruction.
//
// PURE.

export const BRAIN_QUESTION_SCHEMA_ID = 'brain.question';
export const BRAIN_QUESTION_SCHEMA_VERSION = '1';

export const BRAIN_QUESTION_KINDS = ['CHOOSE_ONE', 'CONFIRM', 'SHORT_TEXT'] as const;
export type BrainQuestionKind = (typeof BRAIN_QUESTION_KINDS)[number];

export interface BrainQuestionOption {
  readonly id: string;
  readonly label: string;
  /** The governed record this option stands for, as a `type:id` reference. Null for a plain choice. */
  readonly ref: string | null;
}

export type BrainQuestion =
  | { readonly kind: 'CHOOSE_ONE'; readonly prompt: string; readonly options: readonly BrainQuestionOption[] }
  | { readonly kind: 'CONFIRM'; readonly prompt: string }
  | { readonly kind: 'SHORT_TEXT'; readonly prompt: string; readonly maxLength: number };

export type BrainQuestionReply =
  | { readonly kind: 'CHOOSE_ONE'; readonly optionId: string }
  | { readonly kind: 'CONFIRM'; readonly confirmed: boolean }
  | { readonly kind: 'SHORT_TEXT'; readonly text: string };

export const BRAIN_QUESTION_LIMITS = Object.freeze({
  maxPromptChars: 500,
  minOptions: 2,
  maxOptions: 10,
  maxLabelChars: 120,
  maxShortText: 1000,
});

export const BRAIN_QUESTION_REFUSALS = [
  'NOT_AN_OBJECT',
  'UNKNOWN_KIND',
  'UNEXPECTED_FIELD',
  'PROMPT_INVALID',
  'OPTIONS_INVALID',
  'OPTION_INVALID',
  'DUPLICATE_OPTION',
  'MAX_LENGTH_INVALID',
] as const;
export type BrainQuestionRefusal = (typeof BRAIN_QUESTION_REFUSALS)[number];

export const BRAIN_REPLY_REFUSALS = [
  'NOT_AN_OBJECT',
  'KIND_MISMATCH',
  'UNEXPECTED_FIELD',
  'NOT_AN_OFFERED_OPTION',
  'NOT_A_BOOLEAN',
  'TEXT_INVALID',
  'TEXT_TOO_LONG',
] as const;
export type BrainReplyRefusal = (typeof BRAIN_REPLY_REFUSALS)[number];

const OPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REF = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9_-]{1,128}$/;

/** Control characters other than tab, newline and carriage return never belong in a prompt, label or reply. */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) return true;
  }
  return false;
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function onlyKeys(r: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(r).every((k) => allowed.includes(k));
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !hasControl(value);
}

/** A question as a task asks it. Parsed before it is stored, so only well-formed questions wait. */
export function parseBrainQuestion(
  raw: unknown,
): { readonly ok: true; readonly question: BrainQuestion } | { readonly ok: false; readonly refusals: readonly BrainQuestionRefusal[] } {
  const r = record(raw);
  if (!r) return { ok: false, refusals: ['NOT_AN_OBJECT'] };
  const out: BrainQuestionRefusal[] = [];
  const L = BRAIN_QUESTION_LIMITS;
  if (!text(r.prompt, L.maxPromptChars)) out.push('PROMPT_INVALID');
  switch (r.kind) {
    case 'CHOOSE_ONE': {
      if (!onlyKeys(r, ['kind', 'prompt', 'options'])) out.push('UNEXPECTED_FIELD');
      const options = Array.isArray(r.options) ? r.options : null;
      if (!options || options.length < L.minOptions || options.length > L.maxOptions) {
        out.push('OPTIONS_INVALID');
        break;
      }
      const seen = new Set<string>();
      const parsed: BrainQuestionOption[] = [];
      for (const item of options) {
        const o = record(item);
        const ref = o?.ref ?? null;
        if (
          !o ||
          !onlyKeys(o, ['id', 'label', 'ref']) ||
          typeof o.id !== 'string' ||
          !OPTION_ID.test(o.id) ||
          !text(o.label, L.maxLabelChars) ||
          !(ref === null || (typeof ref === 'string' && REF.test(ref)))
        ) {
          out.push('OPTION_INVALID');
          continue;
        }
        if (seen.has(o.id)) out.push('DUPLICATE_OPTION');
        seen.add(o.id);
        parsed.push({ id: o.id, label: o.label as string, ref: ref as string | null });
      }
      if (out.length > 0) break;
      return { ok: true, question: { kind: 'CHOOSE_ONE', prompt: r.prompt as string, options: parsed } };
    }
    case 'CONFIRM':
      if (!onlyKeys(r, ['kind', 'prompt'])) out.push('UNEXPECTED_FIELD');
      if (out.length > 0) break;
      return { ok: true, question: { kind: 'CONFIRM', prompt: r.prompt as string } };
    case 'SHORT_TEXT':
      if (!onlyKeys(r, ['kind', 'prompt', 'maxLength'])) out.push('UNEXPECTED_FIELD');
      if (!Number.isInteger(r.maxLength) || (r.maxLength as number) < 1 || (r.maxLength as number) > L.maxShortText) {
        out.push('MAX_LENGTH_INVALID');
      }
      if (out.length > 0) break;
      return { ok: true, question: { kind: 'SHORT_TEXT', prompt: r.prompt as string, maxLength: r.maxLength as number } };
    default:
      out.push('UNKNOWN_KIND');
  }
  return { ok: false, refusals: [...new Set(out)] };
}

/** A person's answer, checked against exactly the question it answers. */
export function parseBrainQuestionReply(
  question: BrainQuestion,
  raw: unknown,
): { readonly ok: true; readonly reply: BrainQuestionReply } | { readonly ok: false; readonly refusals: readonly BrainReplyRefusal[] } {
  const r = record(raw);
  if (!r) return { ok: false, refusals: ['NOT_AN_OBJECT'] };
  if (r.kind !== question.kind) return { ok: false, refusals: ['KIND_MISMATCH'] };
  const out: BrainReplyRefusal[] = [];
  switch (question.kind) {
    case 'CHOOSE_ONE':
      if (!onlyKeys(r, ['kind', 'optionId'])) out.push('UNEXPECTED_FIELD');
      if (typeof r.optionId !== 'string' || !question.options.some((o) => o.id === r.optionId)) out.push('NOT_AN_OFFERED_OPTION');
      if (out.length > 0) break;
      return { ok: true, reply: { kind: 'CHOOSE_ONE', optionId: r.optionId as string } };
    case 'CONFIRM':
      if (!onlyKeys(r, ['kind', 'confirmed'])) out.push('UNEXPECTED_FIELD');
      if (typeof r.confirmed !== 'boolean') out.push('NOT_A_BOOLEAN');
      if (out.length > 0) break;
      return { ok: true, reply: { kind: 'CONFIRM', confirmed: r.confirmed as boolean } };
    case 'SHORT_TEXT':
      if (!onlyKeys(r, ['kind', 'text'])) out.push('UNEXPECTED_FIELD');
      if (typeof r.text !== 'string' || r.text.trim() === '' || hasControl(r.text)) out.push('TEXT_INVALID');
      else if (r.text.length > question.maxLength) out.push('TEXT_TOO_LONG');
      if (out.length > 0) break;
      return { ok: true, reply: { kind: 'SHORT_TEXT', text: r.text as string } };
  }
  return { ok: false, refusals: [...new Set(out)] };
}
