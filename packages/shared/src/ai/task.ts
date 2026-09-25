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
  // 1.1.0 (PR 1): the output schema moves to v2, one both providers accept. The answer's shape and the
  // rules it is judged by are unchanged; only the schema sent to the provider is.
  version: '1.1.0',
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
  outputSchemaId: 'mail-reply-draft.v2',
  maxOutputTokens: 2000,
  timeoutMs: 25_000,
  tools: Object.freeze([]),
});

/**
 * TELEGRAM CONTENT TRIAGE (Slice: content-triage, v2 conversation triage). A conservative,
 * employee-private read of a bounded RECENT CONVERSATION that returns the obligations still
 * UNRESOLVED given the whole back-and-forth, each anchored to the message where it originated. If a
 * later message answers or fulfils an earlier ask, that ask is NOT returned. A conversation may carry
 * several unrelated obligations, or none.
 *
 * IT RUNS ONLY AFTER THE EMPLOYEE AUTHORIZES CONTENT PROCESSING (a separate consent from connecting
 * the source and from the content-free history baseline), and only while a live credential is held.
 * The one consent covers BOTH the recent historical window (transiently re-read to surface existing
 * unresolved items) and new messages going forward. Every message body is transient: read for this one
 * call and dropped -- never persisted, never logged, never in the derived WorkItem or its evidence. The
 * result is EMPLOYEE-PRIVATE: an OWNER does not hold it, an ADMIN does not hold it, and nothing here is
 * promoted to an organization surface.
 *
 * COMMUNICATION_CONTENT, because the evidence IS the conversation. Every message block is marked
 * UNTRUSTED_INPUT -- a Telegram message is data, never an instruction, whatever it says inside.
 *
 * `sourceConnections:view` is the read authority (the employee may view their own Telegram source).
 * Every human role may invoke it; AI_EMPLOYEE is never an invoker, by the runtime's own rule and by
 * `sourceConnections` denying it. GENERAL_REASONING is the honest capability route: this is a
 * classification, not language for a person and not technical analysis.
 */
export const AI_TASK_TELEGRAM_CONTENT_TRIAGE: AiTaskDefinition = Object.freeze({
  taskId: 'telegram.content.triage',
  // v2 (conversation triage): reads a bounded recent conversation and returns still-unresolved
  // obligations, each anchored to its originating message. v2.1: each obligation carries enough
  // MINIMIZED business context to be useful -- what specifically happened, what the person must do, and
  // any GROUNDED deadline -- and the conversation is named by the label Telegram itself shows (never a
  // name the model produced). The output schema and the routing entry's taskVersion move in lockstep.
  // v3.0.0 (Chats Intelligence, 2026-09-25): the SAME one call also returns a minimized reading of the
  // whole conversation (`conversation`: relevance, a paraphrased summary, topics, anchored developments,
  // decisions and commitments, commercial/operational signals, what is unresolved, whether it needs the
  // person, and Loop's confidence). The worker stores that reading as the person's private CHATS digest
  // (`intelligence_digests`); the obligations are unchanged and remain WorkItems. ONE invocation still
  // produces both -- there is no second pass and no rollup model call. Output schema v4.
  version: '3.0.0',
  // A conservative actionability judgment over a conversation: general reasoning, not communication
  // drafting and not technical analysis. GENERAL_REASONING has no default provider, so the routing
  // entry names one and says why.
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
  outputSchemaId: 'telegram-content-triage.v4',
  // Informational: the reviewed routing policy sets each call's actual ceiling and deadline.
  maxOutputTokens: 2000,
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
   * v2 conversation triage: the still-unresolved obligations across a bounded recent conversation,
   * each anchored to its originating message. Like `draft`, it is checked for shape and size and NOT
   * figure-checked -- a minimized paraphrase naturally restates a fact, and what stands behind it is a
   * person reading their own conversation, not a validator. An EMPTY list is a VALID answer (nothing
   * is unresolved), and nothing is raised.
   */
  readonly conversationTriage?: AiConversationTriage;
}

export interface AiDraftText {
  readonly body: string;
}

/**
 * TELEGRAM CONTENT TRIAGE (Slice: content-triage, v2.1). What Loop will accept as the read of a bounded
 * recent CONVERSATION, for a task whose RESULT IS A CLASSIFICATION (`resultType: 'TRIAGE'`).
 *
 * It carries NO body and NO verbatim excerpt. Each obligation is one still-UNRESOLVED item with enough
 * MINIMIZED business context to act on: `oneLineMeaning` (WHAT specifically happened or is being asked),
 * `topic` (what it is about), `nextStep` (what the person must do) and `deadline` (a time constraint,
 * or null) -- every one a paraphrase the reader sees, never a quote -- plus `anchorOrdinal`, the 1-based
 * position of the message that ORIGINATED it inside the evaluated window.
 *
 * WHO IT IS WITH IS NOT A MODEL FIELD. The conversation is named by the label Telegram itself shows
 * (a contact's display name or a group title), supplied to the model as context and recorded by Loop
 * from that same source; there is no output field a model could put an invented person or company
 * into. A DEADLINE IS GROUNDED: it must be composed of words that appear in the conversation, or the
 * whole answer is rejected (UNGROUNDED_DEADLINE) -- a model may restate a date the person wrote, never
 * produce one. NONE is never a category here -- the list holds only real, unresolved obligations, and
 * an EMPTY list is the honest answer when the conversation resolved everything (or asked nothing).
 * Nothing else is figure-checked: a minimized paraphrase naturally restates a fact, and what stands
 * behind it is the employee reading their own conversation.
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

/** One still-unresolved obligation, anchored to the 1-based ordinal of its originating message. */
export interface AiTriageObligation {
  /** 1-based position of the originating message in the evaluated window ([1..chunkSize]). */
  readonly anchorOrdinal: number;
  /** The kind of unresolved thing. Never NONE -- the list holds only real obligations. */
  readonly category: AiTriageCategory;
  /** WHAT specifically happened or is being asked, as a minimized paraphrase (<=140 chars). Never a quote. */
  readonly oneLineMeaning: string;
  /** What it is about, in a few words (<=60 chars). May be empty when the meaning already says it. */
  readonly topic: string;
  /** What the person needs to do, as a minimized paraphrase (<=120 chars). Required. */
  readonly nextStep: string;
  /**
   * A material time constraint, written the way the conversation wrote it (<=40 chars), or null when
   * there is none. GROUNDED: every word must appear in the conversation, or the answer is rejected.
   */
  readonly deadline: string | null;
}

/**
 * The whole conversation's read: the obligations still unresolved (an empty list is valid) and, from v4,
 * the minimized reading of the conversation itself. `conversation` is `undefined` only when the answer
 * did not carry the key at all (which v4 rejects as WRONG_SCHEMA); `null` is the model saying it could
 * not read the conversation -- an honest answer, stored as an INSUFFICIENT digest.
 */
export interface AiConversationTriage {
  readonly items: readonly AiTriageObligation[];
  readonly conversation?: AiConversationIntelligence | null;
}

/**
 * CHATS INTELLIGENCE (triage v4, 2026-09-25). The minimized reading of ONE conversation, produced by the
 * same governed call that finds the obligations. It is INTELLIGENCE, NEVER WORK: nothing here becomes a
 * WorkItem, and the obligations above stay the only thing that does.
 *
 * NO BODY, NO QUOTE, NO TRANSCRIPT. Every field is a short paraphrase in Loop's own words, bounded, and
 * checked after the answer for quotation marks and for any run of `AI_TRIAGE_LIMITS.verbatimRunTokens`
 * consecutive words copied from one message (VERBATIM_CONTENT) -- a digest can say what a conversation
 * is about; it cannot carry what somebody wrote.
 *
 * KNOWLEDGE BASIS IS PER FIELD (the simplest faithful shape). `developments`, `decisions` and
 * `commitments` are OBSERVED: each states what a message itself says and is anchored to that message's
 * ordinal. `summary`, `topics`, `signals`, `unresolved`, `attention` and `relevance` are INFERRED: Loop's
 * reading of the whole back-and-forth. `DIGEST_FIELD_KNOWLEDGE` in intelligence-digest.ts records the
 * same split for the stored digest, so a surface can label an inference as one.
 *
 * NO IDENTITY FIELD. As with the obligations, who the conversation is with is Telegram's own label,
 * recorded by the worker; nothing here is a name field a model could fill.
 *
 * `relevance` IS THE ONLY BASIS FOR CALLING A CONVERSATION "BUSINESS". Nothing else Loop holds about a
 * chat classifies it.
 */
export const AI_CONVERSATION_RELEVANCE = ['BUSINESS', 'NOT_BUSINESS', 'UNCLEAR'] as const;
export type AiConversationRelevance = (typeof AI_CONVERSATION_RELEVANCE)[number];

/** Loop's ordinal reading of how well the conversation supports its own reading. Never a percentage. */
export const AI_CONVERSATION_CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiConversationConfidence = (typeof AI_CONVERSATION_CONFIDENCE)[number];

/** A commercial or operational signal. OPPORTUNITY is upside; RISK and CONCERN are downside; OPERATIONAL is neither. */
export const AI_CONVERSATION_SIGNAL_KINDS = ['OPPORTUNITY', 'RISK', 'CONCERN', 'OPERATIONAL'] as const;
export type AiConversationSignalKind = (typeof AI_CONVERSATION_SIGNAL_KINDS)[number];

/** One short paraphrased statement, anchored to the 1-based ordinal of the message it rests on. */
export interface AiConversationStatement {
  readonly anchorOrdinal: number;
  readonly statement: string;
}

export interface AiConversationSignal extends AiConversationStatement {
  readonly kind: AiConversationSignalKind;
}

export interface AiConversationIntelligence {
  readonly relevance: AiConversationRelevance;
  /** The situation in one minimized paraphrase (<=200 chars). Never a quote. */
  readonly summary: string;
  /** What it is about, a few words each (<=5 x <=40 chars). */
  readonly topics: readonly string[];
  /** What happened (<=4, each <=140, anchored). OBSERVED. */
  readonly developments: readonly AiConversationStatement[];
  /** What was decided (<=3, each <=140, anchored). OBSERVED. */
  readonly decisions: readonly AiConversationStatement[];
  /** What someone committed to (<=3, each <=140, anchored). OBSERVED. */
  readonly commitments: readonly AiConversationStatement[];
  /** Commercial / operational signals (<=3, each <=140, anchored). INFERRED. */
  readonly signals: readonly AiConversationSignal[];
  /** What remains open, in one line (<=140), or null. INFERRED. */
  readonly unresolved: string | null;
  /** Whether it needs the person now, and why (<=120). A reason exactly when needed. INFERRED. */
  readonly attention: { readonly needed: boolean; readonly reason: string | null };
  readonly confidence: AiConversationConfidence;
}

/**
 * Bounds the schema cannot say for every provider, enforced in `validateAiTaskOutput` and the worker's
 * window gather. `maxContextInputTokens` is the whole-context input ceiling the adaptive window keeps
 * every chunk within; a routing test asserts it does not exceed the budget class's per-call input cap.
 * `maxWindowMessages` and `maxMessageChars` bound one gathered window (count and per-message text).
 */
export const AI_TRIAGE_LIMITS = Object.freeze({
  maxMeaningChars: 140,
  maxTopicChars: 60,
  maxNextStepChars: 120,
  maxDeadlineChars: 40,
  /** The conversation label Loop records from Telegram's own display name / group title. Never a model field. */
  maxCounterpartyLabelChars: 60,
  maxLimitations: 6,
  maxLimitationChars: 200,
  maxObligations: 8,
  maxContextInputTokens: 8000,
  maxWindowMessages: 40,
  maxMessageChars: 500,
  // v4 conversation reading (Chats Intelligence). Small on purpose: a reading, not a transcript.
  maxSummaryChars: 200,
  maxConversationTopics: 5,
  maxConversationTopicChars: 40,
  maxDevelopments: 4,
  maxDecisions: 3,
  maxCommitments: 3,
  maxSignals: 3,
  maxStatementChars: 140,
  maxUnresolvedChars: 140,
  maxAttentionReasonChars: 120,
  /**
   * A conversation field may not carry this many consecutive words copied from one message
   * (VERBATIM_CONTENT). Ten, so a paraphrase may reuse a phrase ("the signed roofing contract")
   * but not reproduce a sentence.
   */
  verbatimRunTokens: 10,
});

/**
 * What the supplied evidence actually contains, for checking an answer against.
 * `figures` is per source: a number is supported for a claim only if a source THAT
 * CLAIM CITES contains it. `dates` are the calendar dates the evidence names.
 * `terms` are the lower-cased word tokens the evidence contains (`aiTermsInText`), for
 * checking that a short field a model must COPY from the sources -- a triage deadline --
 * is made only of words that are actually there. Absent means nothing is grounded.
 */
export interface AiSupportedEvidence {
  readonly figures: ReadonlyMap<string, ReadonlySet<number>>;
  readonly dates: ReadonlySet<string>;
  readonly terms?: ReadonlySet<string>;
  /**
   * Every run of `AI_TRIAGE_LIMITS.verbatimRunTokens` consecutive word tokens inside ONE supplied
   * message (`aiVerbatimRuns`), for refusing a conversation reading that copies a sentence. Transient,
   * like `terms`. Absent means nothing can be checked, and a v4 conversation reading is refused.
   */
  readonly verbatimRuns?: ReadonlySet<string>;
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
  /** A triage deadline made of words the conversation never used: a produced date, not a restated one. */
  'UNGROUNDED_DEADLINE',
  /** A conversation reading that quotes (quotation marks) or copies a run of words from a message. */
  'VERBATIM_CONTENT',
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
  // v2 conversation triage: a flat `items` list of still-unresolved obligations. Absent is fine -- the
  // validator decides whether THIS task required it, and an EMPTY list is a valid answer. A partial
  // obligation is not an obligation; reading a half-parsed one as one would throw, so the whole answer
  // is rejected (null) on any shape error.
  let conversationTriage: AiConversationTriage | undefined;
  if (v.items !== undefined) {
    if (!Array.isArray(v.items)) return null;
    const items: AiTriageObligation[] = [];
    for (const raw of v.items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const o = raw as Record<string, unknown>;
      if (typeof o.anchorOrdinal !== 'number' || !Number.isFinite(o.anchorOrdinal)) return null;
      if (typeof o.category !== 'string' || typeof o.oneLineMeaning !== 'string') return null;
      // v2.1: the business context. `nextStep` is required (an obligation with no next step is not
      // one); `topic` defaults to empty; `deadline` is a string or null and nothing else.
      if (typeof o.nextStep !== 'string') return null;
      if (o.topic !== undefined && typeof o.topic !== 'string') return null;
      if (o.deadline !== undefined && o.deadline !== null && typeof o.deadline !== 'string') return null;
      items.push({
        anchorOrdinal: o.anchorOrdinal,
        category: o.category as AiTriageCategory,
        oneLineMeaning: o.oneLineMeaning,
        topic: typeof o.topic === 'string' ? o.topic : '',
        nextStep: o.nextStep,
        deadline: typeof o.deadline === 'string' ? o.deadline : null,
      });
    }
    // v4: the conversation reading. Absent stays absent (the validator decides whether this task needed
    // it); null is an honest "could not read it"; anything else must be EXACTLY the shape -- an unknown
    // key inside it is refused, because this block is what gets stored.
    if (v.conversation === undefined) conversationTriage = { items };
    else if (v.conversation === null) conversationTriage = { items, conversation: null };
    else {
      const conversation = parseConversationIntelligence(v.conversation);
      if (!conversation) return null;
      conversationTriage = { items, conversation };
    }
  }
  return {
    schemaId: v.schemaId,
    summary,
    claims,
    limitations: v.limitations as string[],
    ...(draft ? { draft } : {}),
    ...(conversationTriage ? { conversationTriage } : {}),
  };
}

const CONVERSATION_KEYS = ['relevance', 'summary', 'topics', 'developments', 'decisions', 'commitments', 'signals', 'unresolved', 'attention', 'confidence'];

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseStatements(v: unknown, withKind: boolean): AiConversationSignal[] | AiConversationStatement[] | null {
  if (!Array.isArray(v)) return null;
  const out: (AiConversationStatement | AiConversationSignal)[] = [];
  for (const raw of v) {
    if (!isPlainObject(raw)) return null;
    if (!exactKeys(raw, withKind ? ['kind', 'anchorOrdinal', 'statement'] : ['anchorOrdinal', 'statement'])) return null;
    if (typeof raw.anchorOrdinal !== 'number' || !Number.isFinite(raw.anchorOrdinal) || typeof raw.statement !== 'string') return null;
    if (withKind) {
      if (typeof raw.kind !== 'string') return null;
      out.push({ kind: raw.kind as AiConversationSignalKind, anchorOrdinal: raw.anchorOrdinal, statement: raw.statement });
    } else out.push({ anchorOrdinal: raw.anchorOrdinal, statement: raw.statement });
  }
  return out as AiConversationSignal[] | AiConversationStatement[];
}

/** The v4 conversation block, by exact shape. Null on any deviation -- including one extra key. */
function parseConversationIntelligence(value: unknown): AiConversationIntelligence | null {
  if (!isPlainObject(value) || !exactKeys(value, CONVERSATION_KEYS)) return null;
  const c = value;
  if (typeof c.relevance !== 'string' || typeof c.summary !== 'string' || typeof c.confidence !== 'string') return null;
  if (!Array.isArray(c.topics) || !c.topics.every((t) => typeof t === 'string')) return null;
  if (c.unresolved !== null && typeof c.unresolved !== 'string') return null;
  if (!isPlainObject(c.attention) || !exactKeys(c.attention, ['needed', 'reason'])) return null;
  if (typeof c.attention.needed !== 'boolean') return null;
  if (c.attention.reason !== null && typeof c.attention.reason !== 'string') return null;
  const developments = parseStatements(c.developments, false);
  const decisions = parseStatements(c.decisions, false);
  const commitments = parseStatements(c.commitments, false);
  const signals = parseStatements(c.signals, true);
  if (!developments || !decisions || !commitments || !signals) return null;
  return {
    relevance: c.relevance as AiConversationRelevance,
    summary: c.summary,
    topics: c.topics as string[],
    developments,
    decisions,
    commitments,
    signals: signals as AiConversationSignal[],
    unresolved: c.unresolved as string | null,
    attention: { needed: c.attention.needed, reason: c.attention.reason as string | null },
    confidence: c.confidence as AiConversationConfidence,
  };
}

/**
 * Every run of `n` consecutive word tokens in a text (`aiTermsInText`), joined by one space. The ONE
 * shingler for both sides of the verbatim check, so a message and a field meet on the same runs.
 */
export function aiVerbatimRuns(text: string, n: number = AI_TRIAGE_LIMITS.verbatimRunTokens): string[] {
  const tokens = aiTermsInText(text);
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i += 1) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

/** Quotation marks of any common kind. A paraphrase needs none; a quote always has them. */
const QUOTATION_MARKS = /["\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033\u301D\u301E\uFF02]/;

/** Everything wrong with a v4 conversation reading, given the window's anchor range. */
function conversationRejections(c: AiConversationIntelligence, chunkSize: number, evidence: AiSupportedEvidence): AiOutputRejection[] {
  const L = AI_TRIAGE_LIMITS;
  const out: AiOutputRejection[] = [];
  if (!(AI_CONVERSATION_RELEVANCE as readonly string[]).includes(c.relevance)) out.push('WRONG_SCHEMA');
  if (!(AI_CONVERSATION_CONFIDENCE as readonly string[]).includes(c.confidence)) out.push('WRONG_SCHEMA');
  const texts: string[] = [];
  const bounded = (value: string, max: number) => {
    if (value.trim() === '') out.push('EMPTY_ANSWER');
    if (value.length > max) out.push('ANSWER_TOO_LONG');
    texts.push(value);
  };
  bounded(c.summary, L.maxSummaryChars);
  if (c.topics.length > L.maxConversationTopics) out.push('ANSWER_TOO_LONG');
  for (const topic of c.topics) bounded(topic, L.maxConversationTopicChars);
  const lists: [readonly AiConversationStatement[], number][] = [
    [c.developments, L.maxDevelopments],
    [c.decisions, L.maxDecisions],
    [c.commitments, L.maxCommitments],
    [c.signals, L.maxSignals],
  ];
  for (const [list, max] of lists) {
    if (list.length > max) out.push('ANSWER_TOO_LONG');
    for (const s of list) {
      // Every statement rests on a message actually inside the evaluated window.
      if (!Number.isInteger(s.anchorOrdinal) || s.anchorOrdinal < 1 || s.anchorOrdinal > chunkSize) out.push('WRONG_SCHEMA');
      bounded(s.statement, L.maxStatementChars);
    }
  }
  for (const s of c.signals) if (!(AI_CONVERSATION_SIGNAL_KINDS as readonly string[]).includes(s.kind)) out.push('WRONG_SCHEMA');
  if (c.unresolved !== null) {
    // Nothing open is null, not a blank.
    if (c.unresolved.trim() === '') out.push('WRONG_SCHEMA');
    else bounded(c.unresolved, L.maxUnresolvedChars);
  }
  // A reason exactly when attention is needed: "needed" with no why is not a reading, and a reason for
  // something that does not need the person is a contradiction.
  if (c.attention.needed) {
    if (c.attention.reason === null || c.attention.reason.trim() === '') out.push('WRONG_SCHEMA');
    else bounded(c.attention.reason, L.maxAttentionReasonChars);
  } else if (c.attention.reason !== null) out.push('WRONG_SCHEMA');

  // NO QUOTE, NO COPIED SENTENCE. Fail closed: with nothing to check against, nothing is accepted.
  const runs = evidence.verbatimRuns;
  for (const value of texts) {
    if (QUOTATION_MARKS.test(value)) out.push('VERBATIM_CONTENT');
    if (!runs || aiVerbatimRuns(value).some((run) => runs.has(run))) out.push('VERBATIM_CONTENT');
  }
  return out;
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

/**
 * The word tokens a text contains, lower-cased: runs of letters or digits in any script. The ONE
 * tokenizer for both sides of a grounding check (`AiSupportedEvidence.terms` and the field checked
 * against it), so "by Thursday" and "Thursday?" meet on the same tokens.
 */
export function aiTermsInText(text: string): string[] {
  return String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
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
    if (output.conversationTriage !== undefined) out.push('WRONG_SCHEMA');
  } else if (task.resultType === 'TRIAGE') {
    // v2 conversation triage: a list of still-unresolved obligations. An ABSENT list is not the answer
    // asked for; an EMPTY list IS a valid answer (nothing unresolved) and raises nothing.
    const ct = output.conversationTriage;
    if (!ct) out.push('EMPTY_ANSWER');
    else {
      if (ct.items.length > AI_TRIAGE_LIMITS.maxObligations) out.push('ANSWER_TOO_LONG');
      // Anchors number the MESSAGE blocks only. A conversation-level block (`…_conversation:…` -- the
      // label header or the truncation note) is not anchorable and must not widen the range.
      const chunkSize = [...suppliedRefs].filter((ref) => !/_conversation:/.test(ref)).length;
      for (const item of ct.items) {
        // NONE is never a real obligation, and an unknown category is not the answer asked for.
        if (item.category === 'NONE' || !(AI_TRIAGE_CATEGORIES as readonly string[]).includes(item.category)) {
          out.push('WRONG_SCHEMA');
        }
        // The anchor must point at a message actually inside the evaluated window ([1..chunkSize]).
        if (!Number.isInteger(item.anchorOrdinal) || item.anchorOrdinal < 1 || item.anchorOrdinal > chunkSize) {
          out.push('WRONG_SCHEMA');
        }
        const meaning = item.oneLineMeaning?.trim() ?? '';
        if (meaning === '') out.push('EMPTY_ANSWER');
        if ((item.oneLineMeaning?.length ?? 0) > AI_TRIAGE_LIMITS.maxMeaningChars) out.push('ANSWER_TOO_LONG');
        // v2.1 business context: a next step is the point of the item; the topic is bounded; a deadline
        // is bounded AND grounded -- every word of it must be in the conversation, or it was produced.
        if ((item.nextStep?.trim() ?? '') === '') out.push('EMPTY_ANSWER');
        if ((item.nextStep?.length ?? 0) > AI_TRIAGE_LIMITS.maxNextStepChars) out.push('ANSWER_TOO_LONG');
        if ((item.topic?.length ?? 0) > AI_TRIAGE_LIMITS.maxTopicChars) out.push('ANSWER_TOO_LONG');
        if (item.deadline !== null) {
          if (item.deadline.trim() === '') out.push('WRONG_SCHEMA');
          if (item.deadline.length > AI_TRIAGE_LIMITS.maxDeadlineChars) out.push('ANSWER_TOO_LONG');
          const tokens = aiTermsInText(item.deadline);
          const terms = evidence.terms;
          if (!terms || tokens.length === 0 || tokens.some((t) => !terms.has(t))) out.push('UNGROUNDED_DEADLINE');
        }
      }
      // v4: the conversation reading is REQUIRED as a key -- null (could not tell) is an answer, a
      // missing key is not the answer asked for.
      if (ct.conversation === undefined) out.push('WRONG_SCHEMA');
      else if (ct.conversation !== null) out.push(...conversationRejections(ct.conversation, chunkSize, evidence));
      // Triage limitations are tighter than the general answer bounds (6 items, 200 chars each), and
      // this is the only place those tighter bounds are enforced -- the schema no longer encodes them,
      // because Anthropic's structured outputs reject those length/size keywords.
      if (
        output.limitations.length > AI_TRIAGE_LIMITS.maxLimitations ||
        output.limitations.some((l) => l.length > AI_TRIAGE_LIMITS.maxLimitationChars)
      ) {
        out.push('ANSWER_TOO_LONG');
      }
    }
    if (output.draft !== undefined) out.push('WRONG_SCHEMA');
  } else if (output.draft !== undefined || output.conversationTriage !== undefined) {
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
