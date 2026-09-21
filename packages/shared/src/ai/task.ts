// What Loop asks for, and what it will accept as an answer. Slice AI S0.
//
// Architecture: docs/architecture/loop-ai-runtime.md §6 and §16, approved as PD-F-08.
// A caller invokes a TASK BY NAME. It never chooses a model, never writes a prompt,
// and never sees a provider -- so a task is the only place the question is defined,
// and the only place the answer's shape is agreed.
//
// EVERY MATERIAL CLAIM CITES SUPPLIED EVIDENCE. The first task, Case Explanation,
// exists to explain a Case using facts Loop already holds. An explanation that
// asserts something no supplied block supports is not a better explanation, it is a
// fabrication with good grammar -- so `validateAiTaskOutput` REJECTS it whole. There
// is no partial display of an invalid answer, because a reader cannot tell which
// half was the invented one.
//
// NO WRITES, EVER, AT LAUNCH. A task declares its consequence, and every task here
// is READ_ONLY. Nothing in this contract can propose a domain write, and the
// governance gate refuses a tool that writes.
//
// THREE INDEPENDENT DECLARATIONS (B2). A task says which CAPABILITY it needs
// (capability.ts), what its result MEANS and which authority owns it
// (brain-result.ts), and how it may EXECUTE (brain-execution.ts). None is derived from
// another, and none names a provider or a model: the routing policy does that.
//
// PURE. No clock, no I/O.

import type { AiSensitivityClass } from './context';
import type { AiCapabilityRoute } from './capability';
import { isAiCapabilityRoute } from './capability';
import type { BrainExecutionContract } from './brain-execution';
import { brainExecutionContractViolations } from './brain-execution';
import type { BrainResultOwner, BrainResultType } from './brain-result';
import { brainOwnershipRule } from './brain-result';

export const AI_TASK_CONSEQUENCES = ['READ_ONLY', 'PROPOSES_FOR_APPROVAL'] as const;
export type AiTaskConsequence = (typeof AI_TASK_CONSEQUENCES)[number];

export interface AiTaskDefinition {
  readonly taskId: string;
  readonly version: string;
  /**
   * The capability the task needs. It replaced the retired `profile` in B2, and it is
   * what `ai_invocations.profile` records. The routing policy, never the task, turns it
   * into a provider and a model.
   */
  readonly capabilityRoute: AiCapabilityRoute;
  /** What the output means to Loop. */
  readonly resultType: BrainResultType;
  /** Which authority owns the output, about which kind of subject. */
  readonly resultOwner: BrainResultOwner;
  /** How the task may execute, and its latency and waiting promises. */
  readonly execution: BrainExecutionContract;
  /** The highest sensitivity class this task's context may carry. */
  readonly sensitivityCeiling: AiSensitivityClass;
  readonly consequence: AiTaskConsequence;
  /** The permissions the invoking user must hold, re-checked server-side. */
  readonly requires: readonly { readonly resource: string; readonly action: 'view' }[];
  /**
   * The membership roles that may INVOKE the task, on top of `requires`. Reading the
   * evidence and spending money to have it explained are different acts; an empty
   * list admits nobody. AI_EMPLOYEE is never an invoker, whatever this says: an
   * invocation always traces to a person.
   */
  readonly invokerRoles: readonly string[];
  /** Structured output only: a task whose answer cannot be checked is not a task. */
  readonly outputSchemaId: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Tools the broker may publish to it. Empty at launch, and no tool may write. */
  readonly tools: readonly string[];
}

/**
 * CASE EXPLANATION -- the first slice (§16). It explains a Commercial Intelligence
 * Case from the structured facts the reader can already see.
 *
 * OPERATIONAL data only, and less than the reader can see: the context builder
 * sends structured measurements and system-produced findings, and WITHHOLDS every
 * free-text field a person typed, every name, and every user identifier (see
 * services/ai-runtime/case-explanation-context.ts).
 *
 * VERSION 2 (AI-5). The answer is sectioned -- what Loop observed, why it may
 * matter, and what an operator might consider looking at -- and every figure must
 * come from the sources its own claim cites, including numbers written in prose.
 */
export const AI_TASK_CASE_EXPLANATION: AiTaskDefinition = Object.freeze({
  taskId: 'case.explanation',
  version: '2.0.0',
  // Evidence synthesis about an investigation: technical analysis, whose provider
  // preference the reviewed routing policy already follows (brain-execution-architecture.md §5a).
  capabilityRoute: 'TECHNICAL_ANALYSIS',
  // It explains one Case, and the explanation belongs to Commercial Intelligence.
  resultType: 'ANALYSIS',
  resultOwner: Object.freeze({ authority: 'COMMERCIAL_INTELLIGENCE', subjectType: 'CASE' } as const),
  // Interactive only for now: one model call and a governed fallback. The budgets are
  // the task's promise to the reader, not any host's request limit, and they are a
  // proposal for Charlie and Lexi to confirm. Durable execution is a later, reviewed
  // change to this declaration.
  execution: Object.freeze({
    classes: Object.freeze(['INTERACTIVE'] as const),
    interactive: Object.freeze({ presentationBudgetMs: 20_000, executionDeadlineMs: 75_000, streaming: 'NONE' } as const),
    durable: null,
  }),
  sensitivityCeiling: 'OPERATIONAL',
  consequence: 'READ_ONLY',
  requires: Object.freeze([{ resource: 'commercialIntelligence', action: 'view' } as const]),
  // loop-ai-runtime.md §17: OWNER and ADMIN at launch. MANAGER can open the Case page,
  // and whether they may also invoke the explanation is an open Product decision.
  invokerRoles: Object.freeze(['OWNER', 'ADMIN']),
  outputSchemaId: 'case-explanation.v2',
  // Informational: the reviewed routing policy sets each call's actual ceiling and deadline.
  maxOutputTokens: 6000,
  timeoutMs: 25_000,
  tools: Object.freeze([]),
});

/**
 * MAIL REPLY DRAFT -- Draft with Loop (GM-3).
 *
 * It proposes the text of ONE reply, to ONE conversation, for the employee who asked. It is the
 * first task whose consequence is `PROPOSES_FOR_APPROVAL` rather than `READ_ONLY`, and the
 * approval is not a workflow: it is the person reading the words in their own composer and
 * pressing Send. Nothing this task produces can reach Gmail on its own -- the send path takes a
 * draft id and a human principal, and AI_EMPLOYEE cannot hold `employeeMail:send` at all.
 *
 * COMMUNICATION_CONTENT, because the evidence IS the correspondence: a reply written without the
 * thread would be a form letter. The context carries that one thread and the employee's own
 * instruction, marked UNTRUSTED_INPUT -- an email is data, never instruction (§14.4).
 *
 * `employeeIntelligence:view` is the read authority, which grants that person their own rows and
 * nobody else's. Every human role may invoke it, because answering your own mail is not an
 * administrative act; AI_EMPLOYEE is never an invoker, by the runtime's own rule.
 */
export const AI_TASK_MAIL_REPLY_DRAFT: AiTaskDefinition = Object.freeze({
  taskId: 'mail.reply.draft',
  version: '1.0.0',
  capabilityRoute: 'COMMUNICATION',
  resultType: 'DRAFT',
  // The draft belongs to the employee's own work context, about one thread of their own mail.
  resultOwner: Object.freeze({ authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_MAIL_THREAD' } as const),
  execution: Object.freeze({
    classes: Object.freeze(['INTERACTIVE'] as const),
    interactive: Object.freeze({ presentationBudgetMs: 20_000, executionDeadlineMs: 60_000, streaming: 'NONE' } as const),
    durable: null,
  }),
  sensitivityCeiling: 'COMMUNICATION_CONTENT',
  // READ_ONLY, AND THAT IS THE ARCHITECTURE SPEAKING RATHER THAN A TECHNICALITY. A DRAFT's
  // standing is NON_AUTHORITATIVE (brain-result.ts), so it is not even a proposal awaiting an
  // authority's approval: it is TEXT. Nothing is pending, no queue holds it, and the employee
  // pressing Send is not approving Loop's proposal -- they are sending their own mail, having
  // read some words Loop put in the box. `PROPOSES_FOR_APPROVAL` would overstate what this
  // produces and would imply an approval path that does not and should not exist.
  consequence: 'READ_ONLY',
  requires: Object.freeze([{ resource: 'employeeIntelligence', action: 'view' } as const]),
  invokerRoles: Object.freeze(['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']),
  outputSchemaId: 'mail-reply-draft.v1',
  maxOutputTokens: 2000,
  timeoutMs: 25_000,
  tools: Object.freeze([]),
});

/**
 * TELEGRAM CONTENT TRIAGE (Slice: content-triage). A conservative, employee-private verdict on
 * whether ONE new inbound message in the employee's own Telegram conversation is meaningfully
 * actionable, and if so what kind of thing it is and what it means in one minimized line.
 *
 * IT RUNS ONLY AFTER THE EMPLOYEE AUTHORIZES CONTENT PROCESSING (a separate consent from connecting
 * the source and from the content-free history baseline), and only while a live credential is held.
 * The message body is transient: it is read for this one call and dropped -- never persisted, never
 * logged, never in the derived WorkItem or its evidence. The verdict is EMPLOYEE-PRIVATE: an OWNER
 * does not hold it, an ADMIN does not hold it, and nothing here is promoted to an organization surface.
 *
 * COMMUNICATION_CONTENT, because the evidence IS the message. The one context block is marked
 * UNTRUSTED_INPUT -- a Telegram message is data, never an instruction, whatever it says inside.
 *
 * `sourceConnections:view` is the read authority (the employee may view their own Telegram source).
 * Every human role may invoke it; AI_EMPLOYEE is never an invoker, by the runtime's own rule and by
 * `sourceConnections` denying it. GENERAL_REASONING is the honest capability route: this is a
 * classification, not language for a person and not technical analysis.
 */
export const AI_TASK_TELEGRAM_CONTENT_TRIAGE: AiTaskDefinition = Object.freeze({
  taskId: 'telegram.content.triage',
  version: '1.1.0',
  // A single-message actionability judgment: general reasoning, not communication drafting and not
  // technical analysis. GENERAL_REASONING has no default provider, so the routing entry names one
  // and says why.
  capabilityRoute: 'GENERAL_REASONING',
  resultType: 'TRIAGE',
  // The verdict belongs to the employee's own work context, about one of their own conversations,
  // and to no one else -- the same private authority the Daily Loop's own conclusions have.
  resultOwner: Object.freeze({ authority: 'EMPLOYEE_INTELLIGENCE', subjectType: 'EMPLOYEE_CONVERSATION' } as const),
  execution: Object.freeze({
    classes: Object.freeze(['INTERACTIVE'] as const),
    interactive: Object.freeze({ presentationBudgetMs: 10_000, executionDeadlineMs: 30_000, streaming: 'NONE' } as const),
    durable: null,
  }),
  sensitivityCeiling: 'COMMUNICATION_CONTENT',
  // READ_ONLY: a TRIAGE verdict is NON_AUTHORITATIVE (brain-result.ts). It concludes; it proposes
  // nothing to an approval path, and it can act on nothing -- the task publishes no tool.
  consequence: 'READ_ONLY',
  requires: Object.freeze([{ resource: 'sourceConnections', action: 'view' } as const]),
  invokerRoles: Object.freeze(['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']),
  outputSchemaId: 'telegram-content-triage.v1',
  // Informational: the reviewed routing policy sets each call's actual ceiling and deadline.
  maxOutputTokens: 1000,
  timeoutMs: 20_000,
  tools: Object.freeze([]),
});

export const AI_TASKS: readonly AiTaskDefinition[] = Object.freeze([
  AI_TASK_CASE_EXPLANATION,
  AI_TASK_MAIL_REPLY_DRAFT,
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
]);

export function aiTask(taskId: string): AiTaskDefinition | null {
  return AI_TASKS.find((t) => t.taskId === taskId) ?? null;
}

export const AI_TASK_CONTRACT_VIOLATIONS = [
  'UNKNOWN_CAPABILITY_ROUTE',
  'OWNERSHIP_NOT_PERMITTED',
  'CONSEQUENCE_DOES_NOT_MATCH_RESULT',
  'EXECUTION_CONTRACT_INVALID',
  'NO_INVOKER',
] as const;
export type AiTaskContractViolation = (typeof AI_TASK_CONTRACT_VIOLATIONS)[number];

/**
 * Everything incoherent about a task definition. A result that only informs is
 * READ_ONLY; a result that proposes something to an authority is PROPOSES_FOR_APPROVAL.
 */
export function aiTaskContractViolations(task: AiTaskDefinition): AiTaskContractViolation[] {
  const out: AiTaskContractViolation[] = [];
  if (!isAiCapabilityRoute(task.capabilityRoute)) out.push('UNKNOWN_CAPABILITY_ROUTE');
  const governing = brainOwnershipRule(task.resultType, task.resultOwner);
  if (!governing) out.push('OWNERSHIP_NOT_PERMITTED');
  else {
    const expected = governing.standing === 'PROPOSED' ? 'PROPOSES_FOR_APPROVAL' : 'READ_ONLY';
    if (task.consequence !== expected) out.push('CONSEQUENCE_DOES_NOT_MATCH_RESULT');
  }
  if (brainExecutionContractViolations(task.execution, task.resultType).length > 0) out.push('EXECUTION_CONTRACT_INVALID');
  if (task.invokerRoles.length === 0) out.push('NO_INVOKER');
  return out;
}

// --- The answer Loop will accept ---------------------------------------------------

/**
 * What a claim is for. OBSERVATION: what the evidence shows. SIGNIFICANCE: why it may
 * matter, still from the evidence. CONSIDERATION: something an operator might look
 * into -- phrased as a question or a possibility, never an instruction.
 */
export const AI_CLAIM_KINDS = ['OBSERVATION', 'SIGNIFICANCE', 'CONSIDERATION'] as const;
export type AiClaimKind = (typeof AI_CLAIM_KINDS)[number];

/** One statement, and the evidence it stands on. A claim with no citation is not a claim. */
export interface AiClaim {
  readonly kind: AiClaimKind;
  readonly statement: string;
  /** Source refs from the context package. Never a URL, never a memory, never nothing. */
  readonly citations: readonly string[];
  /** A figure the statement asserts, which Loop checks against the sources it cites. */
  readonly figures: readonly { readonly label: string; readonly value: number }[];
}

export interface AiTaskOutput {
  readonly schemaId: string;
  readonly summary: string;
  readonly claims: readonly AiClaim[];
  /** What the model could not tell from what it was given. Honesty has a field. */
  readonly limitations: readonly string[];
  /**
   * The proposed text, for a task whose RESULT IS PROSE (`resultType: 'DRAFT'`).
   *
   * It is checked for shape and size like everything else, and it is deliberately NOT checked for
   * grounded figures the way a claim is: a reply naturally restates a date or a number from the
   * conversation, and rejecting it for that would reject every useful draft. What stands behind
   * the words is not a validator -- it is a person reading them before pressing Send.
   */
  readonly draft?: AiDraftText;
  /**
   * The classification, for a task whose RESULT IS A CLASSIFICATION (`resultType: 'TRIAGE'`).
   * Like `draft`, it is checked for shape and size and NOT figure-checked -- a minimized paraphrase
   * naturally restates a fact from the message, and what stands behind it is a person reading their
   * own conversation, not a validator.
   */
  readonly triage?: AiTriageVerdict;
}

export interface AiDraftText {
  readonly body: string;
}

/**
 * TELEGRAM CONTENT TRIAGE (Slice: content-triage). What Loop will accept as the verdict on one
 * inbound message, for a task whose RESULT IS A CLASSIFICATION (`resultType: 'TRIAGE'`).
 *
 * It carries NO evidence and NO body. `oneLineMeaning` is a MINIMIZED PARAPHRASE the reader sees --
 * never a verbatim excerpt of the message, and never figure-checked, because a conservative
 * one-line meaning naturally restates a fact. What stands behind it is not a validator: it is the
 * employee reading their own conversation. A non-actionable verdict is category NONE, and nothing is
 * raised.
 */
export const AI_TRIAGE_CATEGORIES = [
  'REQUEST',
  'DECISION_NEEDED',
  'COMMITMENT',
  'DEADLINE',
  'BUSINESS_CHANGE',
  'PROBLEM',
  'FOLLOW_UP',
  'OTHER',
  'NONE',
] as const;
export type AiTriageCategory = (typeof AI_TRIAGE_CATEGORIES)[number];

export interface AiTriageVerdict {
  readonly actionable: boolean;
  readonly category: AiTriageCategory;
  /** A minimized paraphrase (<=140 chars). Never a verbatim excerpt of the message. */
  readonly oneLineMeaning: string;
}

/** Bounds on a triage verdict a person has to read. The schema cannot say these for every provider. */
export const AI_TRIAGE_LIMITS = Object.freeze({ maxMeaningChars: 140, maxLimitations: 6, maxLimitationChars: 200 });

/**
 * What the supplied evidence actually contains, for checking an answer against.
 * `figures` is per source: a number is supported for a claim only if a source THAT
 * CLAIM CITES contains it. `dates` are the calendar dates the evidence names.
 */
export interface AiSupportedEvidence {
  readonly figures: ReadonlyMap<string, ReadonlySet<number>>;
  readonly dates: ReadonlySet<string>;
}

export const AI_OUTPUT_REJECTIONS = [
  'WRONG_SCHEMA',
  'EMPTY_ANSWER',
  'ANSWER_TOO_LONG',
  'UNKNOWN_CLAIM_KIND',
  'UNCITED_CLAIM',
  'CITATION_NOT_SUPPLIED',
  'FIGURE_NOT_SUPPORTED',
  'FIGURE_NOT_IN_CITED_SOURCE',
  'UNSUPPORTED_NUMBER_IN_TEXT',
  'UNSUPPORTED_DATE_IN_TEXT',
  'NUMERIC_CONFIDENCE_PRESENT',
  'RECOMMENDS_AN_ACTION',
] as const;
export type AiOutputRejection = (typeof AI_OUTPUT_REJECTIONS)[number];

/** Bounds on an answer a person has to read. The schema cannot say these for every provider. */
/** What a proposed draft may be. Longer than this is not a reply somebody will read. */
export const AI_DRAFT_LIMITS = Object.freeze({ maxBodyChars: 6000 });

export const AI_ANSWER_LIMITS = Object.freeze({
  maxClaims: 12,
  maxSummaryChars: 800,
  maxStatementChars: 600,
  maxLimitations: 8,
  maxLimitationChars: 400,
  maxFiguresPerClaim: 6,
});

/**
 * The answer as the provider returned it, checked for SHAPE before anything reads it.
 * A claim missing its citations array is not an uncited claim to be rejected later;
 * it is not the answer that was asked for, and reading it as one would throw.
 */
export function parseAiTaskOutput(value: unknown): AiTaskOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.schemaId !== 'string') return null;
  // `summary` and `claims` are optional (default '' and []): a DRAFT or a TRIAGE carries neither.
  // A wrong TYPE is still rejected; `validateAiTaskOutput` decides which task actually required them.
  if (v.summary !== undefined && typeof v.summary !== 'string') return null;
  const summary = typeof v.summary === 'string' ? v.summary : '';
  if (v.claims !== undefined && !Array.isArray(v.claims)) return null;
  if (!Array.isArray(v.limitations) || !v.limitations.every((l) => typeof l === 'string')) return null;
  const claimsInput: unknown[] = Array.isArray(v.claims) ? v.claims : [];
  const claims: AiClaim[] = [];
  for (const raw of claimsInput) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.kind !== 'string' || typeof c.statement !== 'string') return null;
    if (!Array.isArray(c.citations) || !Array.isArray(c.figures)) return null;
    if (!c.citations.every((x) => typeof x === 'string')) return null;
    const figures: { label: string; value: number }[] = [];
    for (const f of c.figures) {
      if (!f || typeof f !== 'object') return null;
      const fig = f as Record<string, unknown>;
      if (typeof fig.label !== 'string' || typeof fig.value !== 'number' || !Number.isFinite(fig.value)) return null;
      figures.push({ label: fig.label, value: fig.value });
    }
    claims.push({ kind: c.kind as AiClaimKind, statement: c.statement, citations: c.citations as string[], figures });
  }
  // A task whose result is prose carries it here. Absent is fine -- the validator decides
  // whether THIS task required it, which is where the task's own contract lives.
  let draft: AiDraftText | undefined;
  if (v.draft !== undefined) {
    if (!v.draft || typeof v.draft !== 'object' || Array.isArray(v.draft)) return null;
    const body = (v.draft as Record<string, unknown>).body;
    if (typeof body !== 'string') return null;
    draft = { body };
  }
  // A task whose result is a classification carries it here, flat. Absent is fine -- the validator
  // decides whether THIS task required it. A partial verdict is not a verdict, and reading it as one
  // would throw.
  let triage: AiTriageVerdict | undefined;
  if (v.actionable !== undefined || v.category !== undefined || v.oneLineMeaning !== undefined) {
    if (typeof v.actionable !== 'boolean' || typeof v.category !== 'string' || typeof v.oneLineMeaning !== 'string') return null;
    triage = { actionable: v.actionable, category: v.category as AiTriageCategory, oneLineMeaning: v.oneLineMeaning };
  }
  return {
    schemaId: v.schemaId,
    summary,
    claims,
    limitations: v.limitations as string[],
    ...(draft ? { draft } : {}),
    ...(triage ? { triage } : {}),
  };
}

/** A model that scores its own certainty is guessing twice. C-05 applies to AI too. */
const CONFIDENCE_LIKE = /\b(\d{1,3})\s?%\s?(confiden|certain|sure|likel)|confidence(\s+score)?\s*[:=]\s*\d|\b(i am|i'm|we are)\s+\d{1,3}\s?%/i;
/** An explanation task may not tell somebody to do something; that is a governed act. */
const RECOMMENDATION_LIKE =
  /\b(you should|you must|you need to|we recommend|i recommend|recommend(ed|ation)? (that|to)|next step[s]? (is|are) to|make sure to|be sure to|(please )?(approve|reject|contact|call|email|escalate|dismiss|assign) (the|this|them|him|her|every|all)\b)/i;

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
/**
 * A run of digits not glued to an identifier. "4,200", "12.5", "20" in "10-20", "24"
 * in "24h" and "3" in "3rd" are numbers; the "12" in "ev_12" or "obs12" is not. Signs
 * are ignored here and handled by the magnitude check.
 */
const NUMBER = /(?<![A-Za-z_\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![A-Za-z_\d.,])\d+(?:\.\d+)?/g;

/** The calendar dates a text names, as YYYY-MM-DD. */
export function aiDatesInText(text: string): string[] {
  return [...String(text).matchAll(ISO_DATE)].map((m) => m[0].slice(0, 10));
}

/**
 * The numbers a text asserts, with ISO dates removed first (they are checked as
 * dates). Digits inside identifiers -- `ev_12`, `obs3` -- are not numbers.
 */
export function aiNumbersInText(text: string): number[] {
  const withoutDates = String(text).replace(ISO_DATE, ' ');
  return [...withoutDates.matchAll(NUMBER)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

function supported(value: number, allowed: ReadonlySet<number>): boolean {
  if (allowed.has(value) || allowed.has(Math.abs(value))) return true;
  // A number written to fewer decimals than the source carries is the same number.
  for (const candidate of allowed) {
    if (Math.abs(candidate - value) < 1e-9) return true;
  }
  return false;
}

/**
 * Every rule an answer breaks. Empty means Loop may show it.
 *
 * A figure is supported only by the sources ITS OWN CLAIM cites. A number written in a
 * claim's prose must also come from those sources; a number in the summary or the
 * limitations must come from somewhere in the evidence. A figure that is not there is
 * not "approximately right" -- it is a number the model produced, and showing it
 * beside real ones would make all of them look equal.
 */
export function validateAiTaskOutput(
  output: AiTaskOutput,
  task: AiTaskDefinition,
  suppliedRefs: ReadonlySet<string>,
  evidence: AiSupportedEvidence,
): AiOutputRejection[] {
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId) out.push('WRONG_SCHEMA');
  // A TRIAGE verdict has no summary and no claims -- its deliverable is the classification below.
  if (task.resultType !== 'TRIAGE' && !output.summary?.trim()) out.push('EMPTY_ANSWER');
  // An analysis with no claims is not an analysis. A DRAFT's deliverable is its prose and a TRIAGE's
  // is its verdict, so neither is required to cite a claim: demanding one would produce padding.
  if (output.claims.length === 0 && task.resultType !== 'DRAFT' && task.resultType !== 'TRIAGE') out.push('EMPTY_ANSWER');

  // A task whose result is prose or a classification is checked for exactly that. A claim-based task
  // may return neither: an answer carrying a payload nobody asked for is not the answer that was
  // asked for, and reading it as one is how a "read-only" task starts proposing actions.
  if (task.resultType === 'DRAFT') {
    const body = output.draft?.body?.trim() ?? '';
    if (body === '') out.push('EMPTY_ANSWER');
    if ((output.draft?.body?.length ?? 0) > AI_DRAFT_LIMITS.maxBodyChars) out.push('ANSWER_TOO_LONG');
    if (output.triage !== undefined) out.push('WRONG_SCHEMA');
  } else if (task.resultType === 'TRIAGE') {
    const t = output.triage;
    if (!t) out.push('EMPTY_ANSWER');
    else {
      if (!(AI_TRIAGE_CATEGORIES as readonly string[]).includes(t.category)) out.push('WRONG_SCHEMA');
      const meaning = t.oneLineMeaning?.trim() ?? '';
      if (meaning === '') out.push('EMPTY_ANSWER');
      if ((t.oneLineMeaning?.length ?? 0) > AI_TRIAGE_LIMITS.maxMeaningChars) out.push('ANSWER_TOO_LONG');
      // A triage verdict's limitations are tighter than the general answer bounds (6 items, 200 chars
      // each), and this is the only place those tighter bounds are enforced -- the schema no longer
      // encodes them, because Anthropic's structured outputs reject those length/size keywords.
      if (
        output.limitations.length > AI_TRIAGE_LIMITS.maxLimitations ||
        output.limitations.some((l) => l.length > AI_TRIAGE_LIMITS.maxLimitationChars)
      ) {
        out.push('ANSWER_TOO_LONG');
      }
      // A verdict and its category cannot disagree: an actionable verdict names a real category, and
      // a non-actionable one is NONE. Anything else is not the verdict Loop asked for.
      if (t.actionable === (t.category === 'NONE')) out.push('WRONG_SCHEMA');
    }
    if (output.draft !== undefined) out.push('WRONG_SCHEMA');
  } else if (output.draft !== undefined || output.triage !== undefined) {
    out.push('WRONG_SCHEMA');
  }

  const L = AI_ANSWER_LIMITS;
  if (
    output.claims.length > L.maxClaims ||
    output.summary.length > L.maxSummaryChars ||
    output.limitations.length > L.maxLimitations ||
    output.limitations.some((l) => l.length > L.maxLimitationChars) ||
    output.claims.some((c) => c.statement.length > L.maxStatementChars || c.figures.length > L.maxFiguresPerClaim)
  ) {
    out.push('ANSWER_TOO_LONG');
  }

  const everywhere = new Set<number>();
  for (const set of evidence.figures.values()) for (const n of set) everywhere.add(n);

  for (const claim of output.claims) {
    if (!(AI_CLAIM_KINDS as readonly string[]).includes(claim.kind)) out.push('UNKNOWN_CLAIM_KIND');
    if (claim.citations.length === 0) out.push('UNCITED_CLAIM');
    const cited = new Set<number>();
    for (const citation of claim.citations) {
      if (!suppliedRefs.has(citation)) out.push('CITATION_NOT_SUPPLIED');
      for (const n of evidence.figures.get(citation) ?? []) cited.add(n);
    }
    for (const figure of claim.figures) {
      if (supported(figure.value, cited)) continue;
      out.push(supported(figure.value, everywhere) ? 'FIGURE_NOT_IN_CITED_SOURCE' : 'FIGURE_NOT_SUPPORTED');
    }
    for (const n of aiNumbersInText(claim.statement)) {
      if (!supported(n, cited)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
    }
  }
  for (const text of [output.summary, ...output.limitations]) {
    for (const n of aiNumbersInText(text)) {
      if (!supported(n, everywhere)) out.push('UNSUPPORTED_NUMBER_IN_TEXT');
    }
  }

  const prose = [output.summary, ...output.claims.map((c) => c.statement), ...output.limitations].join('\n');
  for (const date of aiDatesInText(prose)) {
    if (!evidence.dates.has(date)) out.push('UNSUPPORTED_DATE_IN_TEXT');
  }
  if (CONFIDENCE_LIKE.test(prose)) out.push('NUMERIC_CONFIDENCE_PRESENT');
  if (task.consequence === 'READ_ONLY' && RECOMMENDATION_LIKE.test(prose)) out.push('RECOMMENDS_AN_ACTION');
  return [...new Set(out)];
}
