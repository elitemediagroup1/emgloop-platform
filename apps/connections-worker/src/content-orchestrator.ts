// The worker's PERIODIC CONVERSATION REVIEW (v2 conversation triage). It runs autonomously on a cadence
// (default 10 minutes; LOOP_CONNECTION_CONTENT_INTERVAL_MS, see config.ts) rather than reacting to one
// inbound message. Each cycle discovers the conversations with ANY new activity since the content frontier
// -- an INBOUND or OUTBOUND text message -- and for each such conversation reads a bounded recent WINDOW
// of that conversation TRANSIENTLY and judges which obligations are STILL UNRESOLVED. A conversation with
// NO new message since the frontier is NOT reread. Several new messages in one conversation within a cycle
// cause ONE review (ONE AI invocation), never one call per message. OUTBOUND activity counts on purpose:
// when Matt replies, confirms or resolves, the conversation becomes eligible so RECONCILE can close the
// open Needs You item. Raise a minimized, employee-private WorkItem per obligation, then RECONCILE (close
// obligations a later message answered). The one-time HISTORICAL backfill (historical-content-orchestrator.ts)
// does the initial content seeding; after that, this periodic review maintains understanding incrementally
// from activity. COMPLETELY INDEPENDENT of the live observation sweep and the baseline sweep: this
// orchestrator has NO port that can write the live observation cursor (SourceConnection.cursor) or the
// baseline checkpoint. It advances ONLY the content cursor. That independence is structural, not a promise.
//
// THREE THINGS MUST HOLD BEFORE ANY BODY IS READ FOR AN EMPLOYEE:
//   1. content authorization (dueForContent returns only authorized, not-revoked rows);
//   2. a live, openable credential (openCredential returns non-null);
//   and then, for each conversation, the governed gateway re-checks a THIRD thing itself:
//   3. activation, budget, this person's authority, routing and the output contract.
// A revoke removes (1); a disconnect removes (2); a deployment with AI off makes (3) refuse. Any of them
// yields NO WorkItem. The gateway's refusal (NOT_AVAILABLE) HOLDS the content cursor, so the same new
// messages are judged again once the deployment is configured -- nothing is silently skipped. A TRANSIENT
// model failure (FAILED: a timeout, a provider outage) holds it the same way, so an outage never consumes
// a conversation's activity; only a PERMANENT outcome for this content (a rejected answer, a model
// refusal) is recorded as handled and lets the frontier advance.
//
// THE BODIES ARE TRANSIENT. They are fetched, judged, and dropped. They are never persisted, never logged,
// and never carried into a WorkItem or its evidence -- the evidence keeps keyed identifiers, the invocation
// id, the task version, the category, a truncation flag, the model's MINIMIZED paraphrase fields (topic,
// next step, grounded deadline) and the ONE label Telegram itself gives the conversation. Each title is the
// model's minimized paraphrase, never the message; the label is Telegram's, never the model's.
//
// CHATS INTELLIGENCE (triage v4, 2026-09-25). The SAME one call also returns a minimized reading of the
// conversation. After the obligations are written and reconciled, it is stored as the person's private
// CHATS digest (`recordConversationIntelligence` -> IntelligenceDigestRepository.upsert, consent re-checked
// inside the write). SINK BEFORE CURSOR: a digest write that THROWS (a database failure) holds the frontier
// exactly as a failed WorkItem write does; a governed REFUSAL does not throw -- it is counted, and when it
// says the person's consent or membership has ENDED (CONSENT_NOT_IN_FORCE, NOT_AN_ACTIVE_MEMBER) the rest
// of this authorization's conversations are not read at all (no more bodies after the write layer said
// no) and its cursor holds. Digests are produced ONLY when triage runs: a new text message past the
// frontier, a still-armed historical backfill, or the one-off DIGEST-ONLY Chats Intelligence hydration
// (chats-hydration-orchestrator.ts: conversations with no current digest, no WorkItem written) -- there
// is no other replay of already-read history.

import { createHash } from 'node:crypto';

import {
  TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID,
  type AdapterSession,
  type DueContent,
  type IntelligenceDigestInput,
  type WorkItemDetection,
  type WorkPrincipal,
} from '@emgloop/database';
import {
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  AI_TRIAGE_LIMITS,
  DIGEST_LABEL_MAX_CHARS,
  DIGEST_LIST_MAX_ITEMS,
  entityRefRefusal,
  telegramConversationSubjectRef,
  type ConnectionProvider,
  type DigestContent,
  type IntelligenceGeneratedCoverage,
  type IntelligenceOwedBy,
  type IntelligenceReadingStatus,
  type IntelligenceSignal,
  type IntelligenceSignalKind,
} from '@emgloop/shared';

import type { TelegramConversationTriageInput, TelegramConversationTriageResult } from '@emgloop/database';
import type { TelegramContentMessage, TelegramConversationWindow } from './telegram/telegram-content';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What one content DISCOVERY page produced. Content-bearing but TRANSIENT: bodies are dropped after use. */
export interface ContentObservationResult {
  readonly messages: readonly TelegramContentMessage[];
  /** The next content cursor. NEVER the live observation cursor and NEVER the baseline checkpoint. */
  readonly nextCursor: string | null;
  /** Present when the provider asked Loop to wait: the cursor holds and the sweep backs off. */
  readonly floodWaitSeconds?: number;
}

/** One conversation window fetch result. A FLOOD_WAIT yields an empty window and the wait. */
export interface ContentWindowResult {
  readonly window: TelegramConversationWindow;
  readonly floodWaitSeconds?: number;
}

/** The adapter capability the forward content sweep needs. TelegramAdapter satisfies this structurally. */
export interface ContentAdapter {
  readonly provider: ConnectionProvider;
  resume(secret: string, binding: { organizationId: string; userId: string }): Promise<AdapterSession>;
  observeContent(session: AdapterSession, cursor: string | null, limit: number, now: Date): Promise<ContentObservationResult>;
  fetchConversationWindow(
    session: AdapterSession,
    request: { chatId: string; floorAt: Date; maxMessages: number; tokenBudget: number },
    now: Date,
  ): Promise<ContentWindowResult>;
  disconnect(session: AdapterSession): Promise<void>;
}

/** What one content run records. NEVER carries the live observation cursor or the baseline checkpoint. */
export interface ContentProgressToRecord {
  readonly contentCursor: string | null;
  readonly failureClass: string | null;
  readonly backoffUntil: Date | null;
  readonly now: Date;
}

export interface ContentSweepPorts {
  /** Content authorizations worth a run now (platform-wide; routing fields only). */
  dueForContent(): Promise<readonly DueContent[]>;
  /** The adapter for a provider, or null when this deployment has none wired. */
  adapterFor(provider: ConnectionProvider): ContentAdapter | null;
  /** Open the sealed credential for one authorization's connection; null when none is held or it will not open. */
  openCredential(due: DueContent): Promise<string | null>;
  /** The HMAC key that turns raw chat/user ids into one-way conversation keys. */
  readonly conversationSecret: string;
  /** Read ONE conversation window through the governed AI runtime. The bodies reach nothing but that call. */
  triage(principal: WorkPrincipal, input: TelegramConversationTriageInput): Promise<TelegramConversationTriageResult>;
  /** Persist ONE minimized, employee-private obligation WorkItem (WorkItemRepository.detect). No body, ever. */
  raiseWorkItem(principal: WorkPrincipal, detection: WorkItemDetection): Promise<void>;
  /** Close obligations a later message answered (WorkItemRepository.resolveObligationsNotIn), with the guard. */
  resolveObligations(
    principal: WorkPrincipal,
    subjectRef: string,
    keptAnchorProviderEventIds: readonly string[],
    evaluatedFloorProviderEventId: string,
    occurredAt: Date,
  ): Promise<void>;
  /**
   * Store ONE conversation's minimized reading as the person's private CHATS digest
   * (IntelligenceDigestRepository.upsert, basis CONTENT_AUTHORIZATION, consent re-checked in the write).
   * THROWS on a database failure (the frontier holds); returns a governed refusal otherwise.
   */
  recordConversationIntelligence(principal: WorkPrincipal, digest: IntelligenceDigestInput): Promise<ConversationIntelligenceWrite>;
  /** Advance (or hold) the content cursor. MUST NOT touch source_connections or the baseline. */
  recordContentProgress(due: DueContent, progress: ContentProgressToRecord): Promise<void>;
  /** How many new messages one discovery page reads per authorization (bounded). */
  readonly contentPageSize: number;
  /** How many days back the forward conversation window may reach (bounded, so a window is never unbounded). */
  readonly contentWindowDays: number;
  now(): Date;
}

export interface ContentSweepSummary {
  readonly due: number;
  readonly swept: number;
  readonly skipped: number;
  readonly held: number;
  readonly raised: number;
  readonly reconciled: number;
  readonly refused: number;
  readonly floodWaits: number;
  /** Conversation digests written (new or version + 1), unchanged (same evidence), and refused. Counts only. */
  readonly digestsWritten: number;
  readonly digestsUnchanged: number;
  readonly digestsRefused: number;
}

/**
 * What storing one conversation reading came to. WRITTEN / UNCHANGED are the repository's; REFUSED names
 * its governed refusal (never content); NOT_MIGRATED means `intelligence_digests` does not exist in this
 * database yet (a worker deployed ahead of its migration) -- nothing is written and nothing is held, so
 * the obligations keep flowing and the AI spend is not repeated on every cycle.
 */
export type ConversationIntelligenceWrite =
  | { readonly outcome: 'WRITTEN' | 'UNCHANGED' | 'NOT_MIGRATED' }
  | { readonly outcome: 'REFUSED'; readonly refusal: string };

/** Refusals that mean the person's consent or membership has ENDED: stop reading this authorization. */
export const DIGEST_REFUSALS_THAT_END_THE_RUN: readonly string[] = Object.freeze(['CONSENT_NOT_IN_FORCE', 'NOT_AN_ACTIVE_MEMBER']);

/** Per-sweep digest counters, shared by both content sweeps. */
export interface DigestTally {
  written: number;
  unchanged: number;
  refused: number;
}

/**
 * Store one TRIAGED conversation's reading and count it. Returns the refusal that ENDS this
 * authorization's run (consent or membership ended), or null to carry on. Throws what the port throws.
 */
export async function recordConversationReading(
  record: (principal: WorkPrincipal, digest: IntelligenceDigestInput) => Promise<ConversationIntelligenceWrite>,
  principal: WorkPrincipal,
  window: Pick<TelegramConversationWindow, 'conversationKey' | 'messages'>,
  result: Extract<TelegramConversationTriageResult, { outcome: 'TRIAGED' }>,
  truncated: boolean,
  now: Date,
  tally: DigestTally,
): Promise<string | null> {
  const digest = buildConversationDigest(window, result, truncated, now);
  if (!digest) return null;
  const written = await record(principal, digest);
  if (written.outcome === 'WRITTEN') tally.written += 1;
  else if (written.outcome === 'UNCHANGED') tally.unchanged += 1;
  else if (written.outcome === 'REFUSED') {
    tally.refused += 1;
    if (DIGEST_REFUSALS_THAT_END_THE_RUN.includes(written.refusal)) return written.refusal;
  }
  return null;
}

/** The producer identity for a content-triage WorkItem. MODEL, so it is the same row a rule would write. */
const PRODUCER_ID = AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId;

/** Run one forward content sweep over all due authorizations. Never throws for a single authorization. */
export async function runContentSweep(ports: ContentSweepPorts): Promise<ContentSweepSummary> {
  const due = await ports.dueForContent();
  const now = ports.now();
  let swept = 0;
  let skipped = 0;
  let held = 0;
  let raised = 0;
  let reconciled = 0;
  let refused = 0;
  let floodWaits = 0;
  const tally: DigestTally = { written: 0, unchanged: 0, refused: 0 };

  for (const item of due) {
    try {
      const adapter = ports.adapterFor(item.provider);
      if (!adapter) {
        skipped += 1;
        continue;
      }
      // GATE 2: a live, openable credential. A revoke already excluded this row (GATE 1) upstream; a
      // disconnect removes the credential here.
      const secret = await ports.openCredential(item);
      if (secret === null) {
        skipped += 1;
        continue;
      }

      let session: AdapterSession;
      try {
        session = await adapter.resume(secret, { organizationId: item.organizationId, userId: item.userId });
      } catch {
        await ports.recordContentProgress(item, hold(item.contentCursor, 'AUTH', null, now));
        held += 1;
        continue;
      }

      // Discovery: which NEW messages have arrived since the content cursor (bounded, transient).
      let page: ContentObservationResult;
      try {
        page = await adapter.observeContent(session, item.contentCursor, ports.contentPageSize, now);
      } catch {
        await ports.recordContentProgress(item, hold(item.contentCursor, 'TRANSIENT', null, now));
        held += 1;
        await adapter.disconnect(session).catch(() => undefined);
        continue;
      }

      if (page.floodWaitSeconds !== undefined) {
        const backoffUntil = new Date(now.getTime() + Math.max(0, page.floodWaitSeconds) * 1000);
        await ports.recordContentProgress(item, hold(item.contentCursor, 'FLOOD_WAIT', backoffUntil, now));
        held += 1;
        floodWaits += 1;
        await adapter.disconnect(session).catch(() => undefined);
        continue;
      }

      const outcome = await processConversations(ports, adapter, session, item, page.messages, now, tally);
      await adapter.disconnect(session).catch(() => undefined);

      raised += outcome.raised;
      reconciled += outcome.reconciled;
      if (outcome.refused) refused += 1;
      if (outcome.floodWait) floodWaits += 1;

      if (outcome.hold) {
        // A governance refusal or a window flood HOLDS the cursor at where it was, so the same new messages
        // are retried; nothing is silently skipped.
        await ports.recordContentProgress(item, hold(item.contentCursor, outcome.failureClass, outcome.backoffUntil, now));
        held += 1;
        continue;
      }
      // Discovery advances the content cursor to the highest new message id seen, exactly as before.
      await ports.recordContentProgress(item, { contentCursor: page.nextCursor, failureClass: null, backoffUntil: null, now });
      swept += 1;
    } catch {
      // A single authorization's unexpected error never breaks the sweep.
      held += 1;
    }
  }

  return {
    due: due.length,
    swept,
    skipped,
    held,
    raised,
    reconciled,
    refused,
    floodWaits,
    digestsWritten: tally.written,
    digestsUnchanged: tally.unchanged,
    digestsRefused: tally.refused,
  };
}

interface ConversationsOutcome {
  readonly raised: number;
  readonly reconciled: number;
  readonly refused: boolean;
  readonly floodWait: boolean;
  readonly hold: boolean;
  readonly failureClass: string | null;
  readonly backoffUntil: Date | null;
}

/**
 * For each conversation with a NEW text message (INBOUND or OUTBOUND) since the content frontier, read its
 * bounded recent window and review it. A governance refusal (NOT_AVAILABLE), a TRANSIENT model failure
 * (FAILED) or a window flood HOLDS the cursor (retry next run); a PERMANENT per-model outcome (a rejected
 * answer, a model refusal) is recorded as handled. Obligations are raised, then reconciled (with the guard)
 * -- so an outbound reply that resolves an open item closes it on this cycle.
 */
async function processConversations(
  ports: ContentSweepPorts,
  adapter: ContentAdapter,
  session: AdapterSession,
  item: DueContent,
  messages: readonly TelegramContentMessage[],
  now: Date,
  tally: DigestTally,
): Promise<ConversationsOutcome> {
  const principal: WorkPrincipal = { organizationId: item.organizationId, userId: item.userId };
  const floorAt = new Date(now.getTime() - Math.max(1, ports.contentWindowDays) * DAY_MS);
  let raised = 0;
  let reconciled = 0;

  // The conversations with ANY new text message (INBOUND or OUTBOUND) since the frontier, by raw chat id,
  // oldest-first-seen for stability. The `seen` set makes several new messages in one conversation ONE review.
  const chatIds: string[] = [];
  const seen = new Set<string>();
  for (const message of [...messages].sort((a, b) => Number(a.messageId) - Number(b.messageId))) {
    if (message.text.trim() === '') continue; // any new TEXT (inbound OR outbound) is activity; non-text is not
    if (seen.has(message.chatId)) continue;
    seen.add(message.chatId);
    chatIds.push(message.chatId);
  }

  for (const chatId of chatIds) {
    const fetched = await adapter.fetchConversationWindow(
      session,
      { chatId, floorAt, maxMessages: AI_TRIAGE_LIMITS.maxWindowMessages, tokenBudget: AI_TRIAGE_LIMITS.maxContextInputTokens },
      now,
    );
    if (fetched.floodWaitSeconds !== undefined) {
      const backoffUntil = new Date(now.getTime() + Math.max(0, fetched.floodWaitSeconds) * 1000);
      return { raised, reconciled, refused: false, floodWait: true, hold: true, failureClass: 'FLOOD_WAIT', backoffUntil };
    }
    const window = fetched.window;
    if (window.messages.length === 0) continue; // nothing to triage in this window

    const truncated = window.truncation.reason !== 'NONE';
    const evaluatedFloor = window.truncation.oldestIncludedProviderEventId ?? '';
    const result = await ports.triage(principal, {
      conversationKey: window.conversationKey,
      messages: window.messages,
      truncated,
      evaluatedFloorProviderEventId: evaluatedFloor,
      conversation: window.conversation,
    });

    // GATE 3 (the gateway's own): not authorized/activated, no provider, no budget. HOLD and retry.
    if (result.outcome === 'NOT_AVAILABLE') {
      return { raised, reconciled, refused: true, floodWait: false, hold: true, failureClass: refusalFailureClass(result.refusals), backoffUntil: null };
    }
    // A TRANSIENT model/runtime failure (a timeout, a provider outage after the gateway's own retries):
    // HOLD the frontier so this conversation's activity is retried next cycle, never consumed silently --
    // the same rule the historical sweep applies. The frontier is per authorization, so a conversation
    // that keeps failing holds every conversation behind it; that is the chosen trade: retry over skip.
    if (result.outcome === 'FAILED') {
      return { raised, reconciled, refused: false, floodWait: false, hold: true, failureClass: 'TRANSIENT', backoffUntil: null };
    }

    if (result.outcome === 'TRIAGED') {
      const subjectRef = telegramConversationSubjectRef(window.conversationKey);
      raised += await raiseObligations(ports, principal, window, result, truncated, now);
      // Reconcile ALWAYS (even with no items: a conversation that resolved everything closes prior items).
      await ports.resolveObligations(principal, subjectRef, result.items.map((o) => o.anchorProviderEventId), result.evaluatedFloorProviderEventId, now);
      reconciled += 1;
      // THEN the conversation reading, from the same call. A throw holds the frontier (sink before cursor);
      // a refusal that says consent or membership ENDED stops this authorization: no further body is read.
      const ended = await recordConversationReading((p, d) => ports.recordConversationIntelligence(p, d), principal, window, result, truncated, now, tally);
      if (ended) return { raised, reconciled, refused: false, floodWait: false, hold: true, failureClass: ended, backoffUntil: null };
    }
    // TRIAGED, REJECTED_OUTPUT and REFUSED_BY_MODEL all mean this conversation was judged (the latter two
    // are permanent for this content); carry on.
  }

  return { raised, reconciled, refused: false, floodWait: false, hold: false, failureClass: null, backoffUntil: null };
}

/**
 * The MINIMIZED, employee-private WorkItem for one obligation. Obligation-level identity: producer +
 * conversation + the KEYED anchor, so a re-triage updates the same row (never a duplicate) and distinct
 * obligations get distinct rows. NO BODY: the title is the model's paraphrase of what happened; the
 * evidence carries keyed identifiers, the invocation id, the task version, the category, a truncation
 * flag, the model's other minimized fields (topic, next step, grounded deadline) and Telegram's OWN label
 * for the conversation -- taken from the window the worker gathered, never from anything the model wrote.
 * Shared by the forward and historical sweeps so both produce byte-identical rows.
 */
export function buildObligationDetection(
  window: Pick<TelegramConversationWindow, 'conversationKey' | 'conversation'>,
  obligation: {
    readonly anchorProviderEventId: string;
    readonly category: string;
    readonly oneLineMeaning: string;
    readonly topic: string;
    readonly nextStep: string;
    readonly deadline: string | null;
    /** Chats v5. Absent on a v4-era caller: read as VIEWER (the only reading v4 had). */
    readonly owedBy?: 'VIEWER' | 'OTHER' | 'UNKNOWN';
    readonly who?: string | null;
  },
  provenance: { readonly invocationId: string; readonly taskVersion: string },
  truncated: boolean,
  detectedAt: Date,
  /** Chats v5: the window's messages, for Loop's own "has the person written since?" arithmetic. */
  messages: readonly { readonly providerEventId: string; readonly direction: 'INBOUND' | 'OUTBOUND' }[] = [],
): WorkItemDetection {
  const { conversationKey, conversation } = window;
  const owedBy = obligation.owedBy ?? 'VIEWER';
  // Loop's own arithmetic, not the model's: did the person write anything after the message that
  // originated this? (null when the anchor is not in the window handed in.)
  const at = messages.findIndex((m) => m.providerEventId === obligation.anchorProviderEventId);
  const repliedAfter = at < 0 ? null : messages.slice(at + 1).some((m) => m.direction === 'OUTBOUND');
  return {
    recurrenceKey: `${PRODUCER_ID}:${conversationKey}:${obligation.anchorProviderEventId}`,
    // WHO OWES IT decides the lane: the person's own obligations need them; one someone else owes is
    // something they are waiting on. UNKNOWN stays with the person -- never silently dropped.
    class: owedBy === 'OTHER' ? 'WAITING_ON_THEM' : 'NEEDS_YOU',
    subjectKind: 'THREAD',
    // The shared prefix is what a withdrawal (a revoked content authorization, a disconnect past its
    // grace window) uses to find every item this producer wrote -- so it is built here from the same
    // constant, never spelled out (DERIVED_WORK_SUBJECT_PREFIXES in @emgloop/shared).
    subjectRef: telegramConversationSubjectRef(conversationKey),
    title: obligation.oneLineMeaning,
    producerKind: 'MODEL',
    producerId: PRODUCER_ID,
    producerVersion: provenance.taskVersion,
    evidence: {
      provider: 'TELEGRAM',
      // The KEYED anchor (never a raw id, never the body); the reconcile guard reads it back.
      providerEventId: obligation.anchorProviderEventId,
      conversationKey,
      aiInvocationId: provenance.invocationId,
      aiTaskVersion: provenance.taskVersion,
      category: obligation.category,
      contextTruncated: truncated,
      // WHO: Telegram's own label for the conversation (minimized upstream), and whether it is a group.
      // Null when Telegram gave none -- never invented, never a model's guess.
      counterpartyLabel: conversation.label,
      conversationKind: conversation.kind,
      // WHAT / DO / WHEN: the model's minimized paraphrases (bounded and, for the deadline, grounded by
      // the gateway's validation). Never a quote, never the message.
      topic: obligation.topic,
      nextStep: obligation.nextStep,
      deadline: obligation.deadline,
      // Chats v5: who appears to owe it, the label the conversation showed for them (never an identity,
      // never an assignment), and whether the person has written since it was raised.
      owedBy,
      who: owedBy === 'OTHER' ? (obligation.who ?? null) : null,
      repliedAfter,
    },
    detectedAt,
  };
}

/** The producer version a conversation digest records: the task and the version that read it. */
function digestProducerVersion(taskVersion: string): string {
  return `${PRODUCER_ID}@${taskVersion}`;
}

/**
 * The digest's MEANING, as a fingerprint: the conversation, the exact ordered evidence the window held,
 * and the output contract that read it. The same evidence re-read (a held page retried, a sweep re-run)
 * fingerprints the same, so the repository answers UNCHANGED and the version does not move; a new
 * message changes the window, so the digest is overwritten at version + 1. Keyed ids only -- no content.
 */
export function conversationDigestFingerprint(conversationKey: string, providerEventIds: readonly string[], schemaId: string): string {
  const hash = createHash('sha256').update([schemaId, conversationKey, ...providerEventIds].join('\n')).digest('hex');
  return `chats:${hash}`;
}

/**
 * The coverage a conversation digest RECORDS (the rest are decided at read time):
 *   INSUFFICIENT  the model said it could not read the conversation (a null reading), or its reading is
 *                 empty of anything observed or inferred at LOW confidence and UNCLEAR relevance;
 *   PARTIAL       the window was truncated -- older messages were not shown, so the reading is true of
 *                 what was read and not of the whole conversation;
 *   SUFFICIENT    otherwise.
 */
export function conversationDigestCoverage(
  reading: Extract<TelegramConversationTriageResult, { outcome: 'TRIAGED' }>['conversation'],
  truncated: boolean,
): IntelligenceGeneratedCoverage {
  if (reading === null) return 'CONNECTED_INSUFFICIENT';
  const saysNothing = reading.signals.length === 0;
  if (reading.relevance === 'UNCLEAR' && reading.confidence === 'LOW' && saysNothing) return 'CONNECTED_INSUFFICIENT';
  return truncated ? 'CONNECTED_PARTIAL' : 'CONNECTED_SUFFICIENT';
}

/** The contract kind each Chats signal is stored as. DECIDED is a change that settled something. */
const CHATS_SIGNAL_KIND: Readonly<Record<string, IntelligenceSignalKind>> = Object.freeze({
  CHANGE: 'CHANGE',
  DECIDED: 'CHANGE',
  DECISION_PENDING: 'DECISION_PENDING',
  OBLIGATION: 'OBLIGATION',
  UNRESOLVED: 'UNRESOLVED',
  STALLED: 'STALLED',
  OPPORTUNITY: 'OPPORTUNITY',
  RISK: 'RISK',
  OPERATIONAL: 'OPERATIONAL',
  UPCOMING: 'UPCOMING',
});
/** What a message itself states is OBSERVED; a reading of the back-and-forth is INFERRED. */
const OBSERVED_CHATS_KINDS: readonly string[] = Object.freeze(['CHANGE', 'DECIDED', 'OBLIGATION']);

/**
 * Who owes an obligation, as the participation contract says it. OTHER is "someone else in this
 * conversation": the counterparty of a PRIVATE chat; in a group, UNKNOWN -- Loop never decides that a
 * participant is a coworker. The label the conversation showed travels as `party`.
 */
function contractOwedBy(owedBy: 'VIEWER' | 'OTHER' | 'UNKNOWN', kind: string | null): IntelligenceOwedBy {
  if (owedBy === 'VIEWER') return 'VIEWER';
  if (owedBy === 'OTHER' && kind === 'PRIVATE') return 'COUNTERPARTY';
  return 'UNKNOWN';
}

const isoOf = (d: Date) => d.toISOString();

/**
 * The MINIMIZED, principal-private CHATS digest of one conversation, from the SAME triage result that
 * produced its obligations. Shared by the forward, historical and hydration sweeps so all write
 * byte-identical rows.
 *
 * MAPPING (triage v5 -> DigestContent). The TYPED reading and signals (participation contract) are the
 * record: each signal anchored (`telegram_message:<keyed id>`), with its kind, severity, knowledge
 * (CHANGE / DECIDED / OBLIGATION observed; the rest inferred), owedBy + party for an obligation, and the
 * anchor's instant. The PR A fields are derived from the same signals so existing readers keep working:
 * developments (CHANGE, then DECIDED as "Decided: ..."), commitments (OBLIGATION), opportunities,
 * concerns (RISK), operational, unresolved (UNRESOLVED, DECISION_PENDING, STALLED); plus relevance,
 * synthesis (summary), topics, stateChange, attention, confidence, limitations -- and `label`, Telegram's
 * OWN minimized label for the conversation, recorded from the provider, never from the model.
 * NO body, NO quote (the gateway refused any).
 *
 * Window = the messages actually evaluated; evidenceCount = how many; lastEvidenceAt = the newest one's
 * instant, which also anchors the 30-day expiry. Null when the window is empty.
 */
export function buildConversationDigest(
  window: Pick<TelegramConversationWindow, 'conversationKey' | 'messages'> & Partial<Pick<TelegramConversationWindow, 'conversation'>>,
  result: Extract<TelegramConversationTriageResult, { outcome: 'TRIAGED' }>,
  truncated: boolean,
  now: Date,
): IntelligenceDigestInput | null {
  if (window.messages.length === 0) return null;
  const instants = window.messages.map((m) => m.occurredAt.getTime());
  const windowStart = new Date(Math.min(...instants));
  const newest = new Date(Math.max(...instants));
  const limitations = result.limitations.map((l) => l.trim()).filter((l) => l !== '').slice(0, DIGEST_LIST_MAX_ITEMS);
  const reading = result.conversation;
  const subjectRef = telegramConversationSubjectRef(window.conversationKey);
  const conversationRef = subjectRef;
  const entityRefs = entityRefRefusal(conversationRef, 'PRINCIPAL') === null ? [conversationRef] : [];
  const rawLabel = window.conversation?.label?.trim() ?? '';
  const label = rawLabel === '' ? null : [...rawLabel].slice(0, DIGEST_LABEL_MAX_CHARS).join('');
  const kind = window.conversation?.kind ?? null;
  const coverage = conversationDigestCoverage(reading, truncated);
  let content: DigestContent;
  const anchors: string[] = [];
  if (reading === null) {
    content = { ...(label ? { label } : {}), limitations };
  } else {
    const occurred = new Map(window.messages.map((m) => [m.providerEventId, m.occurredAt] as const));
    const anchor = (id: string) => {
      if (!anchors.includes(id)) anchors.push(id);
      return id;
    };
    const of = (...kinds: string[]) => reading.signals.filter((s) => kinds.includes(s.kind));
    const texts = (list: readonly { readonly anchorProviderEventId: string; readonly statement: string }[], prefix = '') =>
      list.map((s) => `${prefix}${s.statement}`);
    const signals: IntelligenceSignal[] = reading.signals.map((s, i) => {
      const at = occurred.get(anchor(s.anchorProviderEventId));
      const key = `${s.kind.toLowerCase().replace(/_/g, '-')}.${createHash('sha256').update(s.anchorProviderEventId).digest('hex').slice(0, 10)}.${i}`;
      const owed = s.kind === 'OBLIGATION' && s.owedBy ? contractOwedBy(s.owedBy, kind) : null;
      return {
        key,
        kind: CHATS_SIGNAL_KIND[s.kind] ?? 'CHANGE',
        knowledge: OBSERVED_CHATS_KINDS.includes(s.kind) ? 'OBSERVED' : 'INFERRED',
        statement: s.kind === 'DECIDED' ? `Decided: ${s.statement}`.slice(0, 280) : s.statement,
        ...(entityRefs.length > 0 ? { entities: [...entityRefs] } : {}),
        evidenceRefs: [`telegram_message:${s.anchorProviderEventId}`],
        ...(at ? { occurredAt: isoOf(at) } : {}),
        severity: s.severity,
        confidence: reading.confidence,
        ...(owed ? { owedBy: owed } : {}),
        ...(owed && s.who ? { party: s.who } : {}),
      };
    });
    const pressing = reading.signals.some((s) => s.severity === 'HIGH' || s.kind === 'DECISION_PENDING' || s.kind === 'STALLED' || s.kind === 'RISK' || (s.kind === 'OBLIGATION' && s.owedBy === 'VIEWER'));
    const status: IntelligenceReadingStatus = reading.attention.needed ? 'ATTENTION' : pressing ? 'WATCH' : 'CALM';
    content = {
      ...(label ? { label } : {}),
      relevance: reading.relevance,
      synthesis: reading.summary,
      topics: [...reading.topics],
      developments: [...texts(of('CHANGE')), ...texts(of('DECIDED'), 'Decided: ')].slice(0, DIGEST_LIST_MAX_ITEMS),
      commitments: texts(of('OBLIGATION')).slice(0, DIGEST_LIST_MAX_ITEMS),
      opportunities: texts(of('OPPORTUNITY')).slice(0, DIGEST_LIST_MAX_ITEMS),
      concerns: texts(of('RISK')).slice(0, DIGEST_LIST_MAX_ITEMS),
      operational: texts(of('OPERATIONAL')).slice(0, DIGEST_LIST_MAX_ITEMS),
      unresolved: texts(of('UNRESOLVED', 'DECISION_PENDING', 'STALLED')).slice(0, DIGEST_LIST_MAX_ITEMS),
      ...(reading.stateChange ? { stateChange: reading.stateChange } : {}),
      ...(reading.attention.needed && reading.attention.reason ? { attention: reading.attention.reason } : {}),
      confidence: reading.confidence,
      limitations,
      reading: { statement: reading.summary, status, confidence: reading.confidence },
      signals,
    };
  }
  return {
    domain: 'CHATS',
    subjectKind: 'CONVERSATION',
    subjectRef,
    provider: 'TELEGRAM',
    consentBasis: 'CONTENT_AUTHORIZATION',
    content,
    coverage,
    windowStart,
    windowEnd: newest,
    evidenceCount: window.messages.length,
    lastEvidenceAt: newest,
    provenance: {
      sourceRefs: [subjectRef],
      anchorEventIds: anchors,
      aiInvocationId: result.provenance.invocationId,
      taskId: result.provenance.taskId,
      taskVersion: result.provenance.taskVersion,
      schemaId: TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID,
      producerVersion: digestProducerVersion(result.provenance.taskVersion),
      producerKind: 'MODEL',
      sources: [{ sourceId: 'TELEGRAM', asOf: isoOf(newest), coverage }],
    },
    aiInvocationId: result.provenance.invocationId,
    entityRefs,
    fingerprint: conversationDigestFingerprint(
      window.conversationKey,
      window.messages.map((m) => m.providerEventId),
      TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID,
    ),
    generatedAt: now,
  };
}

/** Raise (or update) one minimized, employee-private WorkItem per obligation. No body, ever. */
async function raiseObligations(
  ports: ContentSweepPorts,
  principal: WorkPrincipal,
  window: TelegramConversationWindow,
  result: Extract<TelegramConversationTriageResult, { outcome: 'TRIAGED' }>,
  truncated: boolean,
  now: Date,
): Promise<number> {
  let raised = 0;
  for (const obligation of result.items) {
    await ports.raiseWorkItem(principal, buildObligationDetection(window, obligation, result.provenance, truncated, now, window.messages));
    raised += 1;
  }
  return raised;
}

/** A progress record that HOLDS the content cursor where it is (never advances it). */
function hold(cursor: string | null, failureClass: string | null, backoffUntil: Date | null, now: Date): ContentProgressToRecord {
  return { contentCursor: cursor, failureClass, backoffUntil, now };
}


/**
 * DIAGNOSTIC (#320): keep the SPECIFIC admission refusal(s) so one sweep names the exact gate that refused,
 * instead of collapsing every governed refusal to the opaque 'REFUSED_BY_LOOP'. `AiAdmissionRefusal` is a
 * fixed, safe enum (NOT_AUTHORIZED / ORGANIZATION_NOT_ENABLED / TASK_NOT_ENABLED / KILL_SWITCH /
 * CONTEXT_REFUSED / LEDGER_UNAVAILABLE / BUDGET_* ...) -- never a message body, a secret, or provider text.
 */
export function refusalFailureClass(refusals: readonly string[]): string {
  return refusals.length > 0 ? `REFUSED_BY_LOOP:${refusals.join('+')}` : 'REFUSED_BY_LOOP';
}
