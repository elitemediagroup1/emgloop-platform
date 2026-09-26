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
import type { AiDomainReading } from './domain-reading';
import type { AiChatsTriage } from './telegram-triage-v5';
import type { AiSituationSynthesis, AiSituationVerification } from './situation-contracts';
import type { AiBriefing } from './briefing-contract';
import { AI_INTELLIGENCE_TASKS } from './intelligence-tasks';

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
  // v4.0.0 (Chats v5, Loop Intelligence Phase B, 2026-09-26): output schema v5 -- each obligation says
  // who appears to owe it (VIEWER / OTHER / UNKNOWN) and names the other party only by a label the
  // conversation showed; the reading carries TYPED signals (decisions pending, stalled, upcoming ...) and
  // a state change. Still ONE call. The schema is portable (a one-value enum, no `const`), so the v4
  // exemption and the OpenAI+triage guard retire with it (telegram-triage-v5.ts).
  version: '4.0.0',
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
  outputSchemaId: 'telegram-content-triage.v5',
  // Informational: the reviewed routing policy sets each call's actual ceiling and deadline.
  maxOutputTokens: 2000,
  timeoutMs: 20_000,
  tools: Object.freeze([]),
});

export const AI_TASKS: readonly AiTaskDefinition[] = Object.freeze([
  AI_TASK_CASE_EXPLANATION,
  AI_TASK_MAIL_REPLY_DRAFT,
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  // Loop Intelligence (Phases D-G, 2026-09-26). Defined, routed and budgeted; activated by nothing.
  ...AI_INTELLIGENCE_TASKS,
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
   * The typed domain reading, for a task answering `domain-reading.v1` (PR 2, `domain-reading.ts`). It
   * is parsed and validated by that contract only; `validateAiTaskOutput` never sees it.
   */
  readonly domainReading?: AiDomainReading;
  /** Chats v5 (`telegram-content-triage.v5`), parsed and validated by `telegram-triage-v5.ts` only. */
  readonly chatsTriage?: AiChatsTriage;
  /** Phase F: situation synthesis / its independent verification (situation-contracts.ts). */
  readonly situationSynthesis?: AiSituationSynthesis;
  readonly situationVerification?: AiSituationVerification;
  /** Phase G: the composed Briefing (briefing-contract.ts). */
  readonly briefing?: AiBriefing;
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

/**
 * The conversation relevance and confidence vocabularies of a Chats reading (triage schema v5,
 * `telegram-triage-v5.ts`, where the obligation and reading types now live). `relevance` IS THE ONLY
 * BASIS FOR CALLING A CONVERSATION "BUSINESS". Nothing else Loop holds about a chat classifies it.
 */
export const AI_CONVERSATION_RELEVANCE = ['BUSINESS', 'NOT_BUSINESS', 'UNCLEAR'] as const;
export type AiConversationRelevance = (typeof AI_CONVERSATION_RELEVANCE)[number];

/** Loop's ordinal reading of how well the conversation supports its own reading. Never a percentage. */
export const AI_CONVERSATION_CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiConversationConfidence = (typeof AI_CONVERSATION_CONFIDENCE)[number];

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
  /**
   * The canonical entity references the context package supplied (PR 2, domain-reading.v1). A reading
   * may name only these; absent means it may name none.
   */
  readonly entityRefs?: ReadonlySet<string>;
  /**
   * Chats v5 (triage schema v5): the lower-cased labels the context showed for people in the conversation
   * (Telegram's conversation label and in-group sender labels). A `who` in the answer must be one of them
   * exactly (UNGROUNDED_PARTY): Loop never records a person the conversation did not name.
   */
  readonly labels?: ReadonlySet<string>;
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
  /** PR 2 (domain-reading.v1): a reading named an entity reference the context did not supply. */
  'ENTITY_NOT_SUPPLIED',
  /** Phase F (situations): a claim asserted a cause the evidence cannot show. */
  'CAUSAL_OVERREACH',
  /** Phase F: a claim joined evidence from windows too far apart to compare. */
  'TEMPORAL_MISMATCH',
  /** Phase F: a NEW situation that is exactly an open one supplied. */
  'DUPLICATE_SITUATION',
  /** Chats v5: a `who` that is not a label the conversation itself showed. */
  'UNGROUNDED_PARTY',
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
  return {
    schemaId: v.schemaId,
    summary,
    claims,
    limitations: v.limitations as string[],
    ...(draft ? { draft } : {}),
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

/**
 * Shared by output contracts outside this file (PR 2, `domain-reading.ts`): the SAME number, date,
 * quotation and prose checks the existing tasks apply, so a new contract cannot drift from them.
 */
export function aiNumberSupported(value: number, allowed: ReadonlySet<number>): boolean {
  return supported(value, allowed);
}

/** A quotation mark of any common kind in a model's text. */
export function aiHasQuotation(text: string): boolean {
  return QUOTATION_MARKS.test(text);
}

/** Numeric self-confidence, and (for a READ_ONLY task) telling somebody what to do. */
export function aiProseRejections(prose: string, consequence: AiTaskConsequence): AiOutputRejection[] {
  const out: AiOutputRejection[] = [];
  if (CONFIDENCE_LIKE.test(prose)) out.push('NUMERIC_CONFIDENCE_PRESENT');
  if (consequence === 'READ_ONLY' && RECOMMENDATION_LIKE.test(prose)) out.push('RECOMMENDS_AN_ACTION');
  return out;
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
  // A TRIAGE is judged by its own registered contract (Chats v5: telegram-triage-v5.ts), never by these
  // claim rules; an answer routed here for a triage task is not the answer that was asked for.
  if (task.resultType === 'TRIAGE') return ['WRONG_SCHEMA'];
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId) out.push('WRONG_SCHEMA');
  if (!output.summary?.trim()) out.push('EMPTY_ANSWER');
  // An analysis with no claims is not an analysis. A DRAFT's deliverable is its prose, so it is not
  // required to cite a claim: demanding one would produce padding.
  if (output.claims.length === 0 && task.resultType !== 'DRAFT') out.push('EMPTY_ANSWER');

  // A task whose result is prose is checked for exactly that. A claim-based task
  // may return neither: an answer carrying a payload nobody asked for is not the answer that was
  // asked for, and reading it as one is how a "read-only" task starts proposing actions.
  if (task.resultType === 'DRAFT') {
    const body = output.draft?.body?.trim() ?? '';
    if (body === '') out.push('EMPTY_ANSWER');
    if ((output.draft?.body?.length ?? 0) > AI_DRAFT_LIMITS.maxBodyChars) out.push('ANSWER_TOO_LONG');
  } else if (output.draft !== undefined) {
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
