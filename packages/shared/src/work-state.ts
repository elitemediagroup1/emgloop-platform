// Daily Loop work state -- the vocabularies, the retention policy and the sensitivity map.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md, slice DL-1 (§26.7).
// The RULES that read these words (who is waiting, what went quiet) arrive in DL-8 and
// belong in this file too; DL-1 defines only what the words are.
//
// EVERY VOCABULARY IS CLOSED, AND THE DATABASE AGREES. Each list below is mirrored by a
// CHECK constraint in the DL-1 migration (and, for item outcomes, restated in full by the
// 2026-10-01 migration that added REVOKED), so a value this file does not know cannot be
// stored even by a caller that bypassed the contract -- the discipline google_connections
// already uses for its scopes.
//
// WHAT IS DELIBERATELY ABSENT. There is no class for "opportunity" and none for "why this
// matters": those need message content Loop does not read (§4.3 Stage 2), and a vocabulary
// that names them now would invite a metadata-derived guess to fill them. Stage 2 adds its
// words in the migration that earns them.
//
// PURE. No clock, no I/O, no environment.

// --- Sources and providers ----------------------------------------------------------------

/** The three Google capabilities Daily Loop reads from, one cursor each. */
export const WORK_SOURCES = ['GMAIL', 'CALENDAR', 'DRIVE'] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

/** The provider a fact came from. One today; the work-state model is provider-neutral by design. */
export const WORK_PROVIDERS = ['GOOGLE'] as const;
export type WorkProvider = (typeof WORK_PROVIDERS)[number];

export function isWorkSource(value: unknown): value is WorkSource {
  return typeof value === 'string' && (WORK_SOURCES as readonly string[]).includes(value);
}

// --- What a thread or an item is about ------------------------------------------------------

/**
 * The four classes metadata can establish honestly (§6.1).
 *
 *   NEEDS_YOU         someone wrote, you have not answered.
 *   WAITING_ON_THEM   you wrote last; no reply since.
 *   GONE_QUIET        a thread that used to move and stopped.
 *   FYI               you are on it, not addressed.
 */
export const WORK_CLASSES = ['NEEDS_YOU', 'WAITING_ON_THEM', 'GONE_QUIET', 'FYI'] as const;
export type WorkClass = (typeof WORK_CLASSES)[number];

/** What a work item is about. A class is never a subject, and a subject is never a party. */
export const WORK_SUBJECT_KINDS = ['THREAD', 'EVENT', 'DOCUMENT', 'CORRESPONDENT'] as const;
export type WorkSubjectKind = (typeof WORK_SUBJECT_KINDS)[number];

/** Which way a message went, from the connected account's point of view. */
export const WORK_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export type WorkDirection = (typeof WORK_DIRECTIONS)[number];

// --- Provenance: four kinds of statement, never merged (§12.1) -------------------------------

/**
 *   SOURCE_FACT  a provider reported it (a message exists, a meeting moved).
 *   DERIVED      a named, versioned rule projected it from facts.
 *   INFERRED     a model read content and concluded it. Stage 2; a PROPOSAL, never state.
 *   CONFIRMED    a person accepted or corrected it. Outranks the three above.
 */
export const WORK_PROVENANCE_KINDS = ['SOURCE_FACT', 'DERIVED', 'INFERRED', 'CONFIRMED'] as const;
export type WorkProvenanceKind = (typeof WORK_PROVENANCE_KINDS)[number];

/**
 * What produced a work item. RULE is all DL-1 can write; MODEL exists so a Stage 2/3 item is
 * the same row with a different producer rather than a second queue (§14.4 seam 2).
 */
export const WORK_PRODUCER_KINDS = ['RULE', 'MODEL'] as const;
export type WorkProducerKind = (typeof WORK_PRODUCER_KINDS)[number];

// --- Item lifecycle ---------------------------------------------------------------------------

/** Where an item sits for the person who owns it. */
export const WORK_ITEM_STATES = ['OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** The states that close an item. `resolvedAt` and `outcome` exist exactly for these. */
export const WORK_ITEM_CLOSED_STATES: readonly WorkItemState[] = Object.freeze(['RESOLVED', 'DISMISSED']);

/**
 * How an item ended. Deliberately the shape the Decision Engine already uses: keeping
 * "Loop should not have raised it" separate from "real, and I dealt with it" is the only
 * feedback the rules ever get about their own accuracy (ENGINEERING_PRINCIPLES Rule 4).
 *
 * REVOKED is SYSTEM-ONLY (2026-09-24): the authorization that produced the item was withdrawn
 * (§21.2), so Loop closed it and minimized it to provenance. It says NOTHING about accuracy --
 * it is never "Loop was wrong" and never "handled" -- and it must never enter an accuracy signal.
 * A person cannot record it (`WorkItemRepository.record` refuses it); only the withdrawal
 * repository writes it.
 */
export const WORK_ITEM_OUTCOMES = ['HANDLED', 'NOT_MINE', 'NO_ACTION_NEEDED', 'FALSE_POSITIVE', 'SUPERSEDED', 'EXPIRED', 'REVOKED'] as const;
export type WorkItemOutcome = (typeof WORK_ITEM_OUTCOMES)[number];

/** The outcomes only the system may write. A human `record()` of one of these fails closed. */
export const WORK_SYSTEM_ONLY_OUTCOMES: readonly WorkItemOutcome[] = Object.freeze(['REVOKED']);

/**
 * The reason a withdrawal observation carries, as a prefix on the caller's own words
 * ("withdrawn: content authorization revoked"). A closed marker, so a reader of the log can tell
 * an authorization being withdrawn from a person closing the item -- the observation row has no
 * outcome column, and an accuracy signal must skip a withdrawal without guessing.
 */
export const WORK_WITHDRAWAL_REASON_PREFIX = 'withdrawn:';

export function workWithdrawalReason(reason: string): string {
  return `${WORK_WITHDRAWAL_REASON_PREFIX} ${reason.trim()}`;
}

export function isWorkWithdrawalReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(WORK_WITHDRAWAL_REASON_PREFIX);
}

/** The append-only log of what happened to an item. */
// WORK_LINKED (Loop Intelligence Phase C): the person promoted this item to Work OS work. It changes no
// state; the item's own lifecycle continues, and the work is Work OS's.
export const WORK_OBSERVATION_TYPES = ['DETECTED', 'REDETECTED', 'SNOOZED', 'UNSNOOZED', 'RESOLVED', 'DISMISSED', 'REOPENED', 'WORK_LINKED'] as const;
export type WorkObservationType = (typeof WORK_OBSERVATION_TYPES)[number];

/** Who acted. There is no AI actor, because no model writes work state. */
export const WORK_ACTOR_TYPES = ['HUMAN', 'SYSTEM'] as const;
export type WorkActorType = (typeof WORK_ACTOR_TYPES)[number];

// --- Corrections --------------------------------------------------------------------------------

/**
 * What a person told Loop it got wrong. Every one is per employee and append-only: a
 * correction tunes one person's own surface and may never become a global rule (§12.5, and
 * Google's Limited Use policy, which permits only that user's own personalized model).
 */
export const WORK_FEEDBACK_KINDS = [
  'NOT_IMPORTANT',
  'ALREADY_HANDLED',
  'NOT_WAITING',
  'SUPPRESS_CORRESPONDENT',
  'SUPPRESS_DOMAIN',
] as const;
export type WorkFeedbackKind = (typeof WORK_FEEDBACK_KINDS)[number];

// --- Replies (GM-2) -------------------------------------------------------------------------------

/** How a reply is addressed. The employee chooses; Loop never widens it for them. */
export const WORK_REPLY_MODES = ['REPLY', 'REPLY_ALL'] as const;
export type WorkReplyMode = (typeof WORK_REPLY_MODES)[number];

/**
 * Where a draft's words came from.
 *
 * `AI_PROPOSED` is a provenance fact, not a status: the employee edits and sends it exactly as
 * they would their own, and Loop keeps the invocation that produced it so an answer can always be
 * traced. There is no third value for "sent by Loop", because that is not a thing Loop does.
 */
export const WORK_DRAFT_SOURCES = ['MANUAL', 'AI_PROPOSED'] as const;
export type WorkDraftSource = (typeof WORK_DRAFT_SOURCES)[number];

/**
 * Why a send did not happen -- or, in `SEND_UNKNOWN`, why Loop cannot yet say whether it did.
 * A class, never a provider's text.
 */
export const WORK_SEND_FAILURE_CLASSES = [
  'NOT_CONNECTED',
  'CAPABILITY_NOT_GRANTED',
  'AUTHORIZATION_EXPIRED',
  'AUTH',
  'FORBIDDEN',
  'RATE_LIMITED',
  'NETWORK',
  'TIMEOUT',
  'MALFORMED',
  'UNAVAILABLE',
  /** Loop itself refused to build the message -- an unsafe header, no recipient, an empty body. */
  'REFUSED',
  /** Gmail answered and refused the message (a 4xx that is not about auth or rate). */
  'REJECTED',
  /** Loop checked Gmail after an ambiguous attempt and established the message was never sent. */
  'NOT_DELIVERED',
] as const;
export type WorkSendFailureClass = (typeof WORK_SEND_FAILURE_CLASSES)[number];

/**
 * Where one reply stands on its way out (GM-2). THE SEND STATE MACHINE.
 *
 *   DRAFT         editable, and sendable. A definitive failure returns here -- and only a
 *                 DEFINITIVE one, because only then is it known that nothing left.
 *   SENDING       claimed, with the attempt's identity already stored, while Gmail is called.
 *   SEND_UNKNOWN  the attempt ended without Loop being able to prove what Gmail did: a timeout, a
 *                 dropped connection, a 5xx, an unreadable 200, or a process that stopped between
 *                 Gmail accepting the message and Loop recording it. IT IS NEVER RETRIED
 *                 AUTOMATICALLY. It leaves only by reconciliation against Gmail's Sent mail, or by
 *                 an explicit, recorded decision of the employee.
 *   SENT          terminal, with Gmail's own message id as the proof.
 *
 * THERE IS NO TIME-BASED WAY OUT OF SENDING OR SEND_UNKNOWN. A claim that "expires" back into
 * DRAFT is exactly how an accepted message gets sent twice; a stale SENDING becomes SEND_UNKNOWN
 * and is reconciled, never released.
 */
export const WORK_DRAFT_SEND_STATES = ['DRAFT', 'SENDING', 'SEND_UNKNOWN', 'SENT'] as const;
export type WorkDraftSendState = (typeof WORK_DRAFT_SEND_STATES)[number];

/** How an attempt that was once in doubt was settled, so the answer can always be explained. */
export const WORK_SEND_RESOLUTIONS = ['RECONCILED_SENT', 'RECONCILED_NOT_SENT', 'RELEASED_BY_EMPLOYEE'] as const;
export type WorkSendResolution = (typeof WORK_SEND_RESOLUTIONS)[number];

/**
 * The clocks of an outbound attempt. Operating policy, stated once.
 *
 *   inFlightMs      a SENDING row younger than this may still be waiting on Gmail. Older, and the
 *                   process that claimed it is gone (the provider call gives up after 10 s and the
 *                   platform kills a request at 60 s), so it becomes SEND_UNKNOWN.
 *   settleMs        before this, finding nothing in Gmail proves nothing: a request may still be
 *                   landing, and Gmail's search index may not show it yet. After it, a COMPLETE
 *                   search of the attempt window that finds nothing is proof it was not sent.
 *   releaseAfterMs  the earliest an employee may explicitly release an unconfirmed attempt after
 *                   checking Gmail themselves -- past the in-flight window, so they cannot race
 *                   their own request.
 *   reconcileFloorMs  Gmail is not asked again about the same attempt more often than this.
 *   windowBeforeMs / windowAfterMs  the span of Sent mail an attempt could have produced,
 *                   generous against clock skew between Loop and Gmail.
 */
export const WORK_SEND_POLICY = Object.freeze({
  inFlightMs: 90 * 1000,
  settleMs: 10 * 60 * 1000,
  releaseAfterMs: 2 * 60 * 1000,
  reconcileFloorMs: 15 * 1000,
  windowBeforeMs: 2 * 60 * 1000,
  windowAfterMs: 10 * 60 * 1000,
});

// --- Sync -----------------------------------------------------------------------------------------

/** How a sync pass ended. TRUNCATED is not a failure: it means the deadline came first. */
export const WORK_SYNC_OUTCOMES = ['SUCCEEDED', 'TRUNCATED', 'FAILED'] as const;
export type WorkSyncOutcome = (typeof WORK_SYNC_OUTCOMES)[number];

/** Why a sync pass could not finish. A class, never a provider's text. */
export const WORK_SYNC_FAILURE_CLASSES = ['NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'AUTH', 'MALFORMED', 'CURSOR_EXPIRED', 'UNAVAILABLE'] as const;
export type WorkSyncFailureClass = (typeof WORK_SYNC_FAILURE_CLASSES)[number];

/** What the stored cursor means for its source. */
export const WORK_CURSOR_KINDS = ['GMAIL_HISTORY_ID', 'CALENDAR_SYNC_TOKEN', 'DRIVE_PAGE_TOKEN'] as const;
export type WorkCursorKind = (typeof WORK_CURSOR_KINDS)[number];

// --- Sensitivity (§14.4 seam 7) ------------------------------------------------------------------

/**
 * What class of data each stored column holds, so a Stage 2/3 context package can enforce a
 * task's ceiling (`AI_SENSITIVITY_CLASSES` in ai/context.ts) instead of discovering it late.
 *
 * A SUBJECT LINE IS TREATED AS CONTENT. Google's metadata scope permits it and the product
 * cannot work without it, but it is the sender's words -- so it never enters an
 * OPERATIONAL-ceiling context and never leaves in an email (§17.4).
 */
export const WORK_STATE_SENSITIVITY: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  work_correspondents: Object.freeze({ addressHash: 'OPERATIONAL', displayAddress: 'CONTACT_IDENTIFIER', displayName: 'CONTACT_IDENTIFIER', domain: 'CONTACT_IDENTIFIER' }),
  work_threads: Object.freeze({ subject: 'COMMUNICATION_CONTENT', participantHashes: 'OPERATIONAL', derivedClass: 'OPERATIONAL' }),
  work_messages: Object.freeze({ subject: 'COMMUNICATION_CONTENT', fromHash: 'OPERATIONAL', toHashes: 'OPERATIONAL', ccHashes: 'OPERATIONAL' }),
  work_events: Object.freeze({ organizerHash: 'OPERATIONAL', attendeeCount: 'OPERATIONAL' }),
  work_documents: Object.freeze({ name: 'COMMUNICATION_CONTENT', ownerHashes: 'OPERATIONAL' }),
  work_items: Object.freeze({ title: 'COMMUNICATION_CONTENT', evidence: 'OPERATIONAL', evidenceQuote: 'COMMUNICATION_CONTENT' }),
  // A draft is the employee's own words, and the addresses they are writing to. It is the only
  // body Loop stores, and it is cleared the moment it is sent.
  work_drafts: Object.freeze({ body: 'COMMUNICATION_CONTENT', subject: 'COMMUNICATION_CONTENT', toAddresses: 'CONTACT_IDENTIFIER', ccAddresses: 'CONTACT_IDENTIFIER' }),
  work_briefs: Object.freeze({ counts: 'OPERATIONAL', coverage: 'OPERATIONAL', headline: 'COMMUNICATION_CONTENT' }),
});

/** The longest an evidence quote may be (§17.4). Enforced by a CHECK, not by a caller. */
export const WORK_EVIDENCE_QUOTE_MAX_CHARS = 240;

// --- Retention (§21.3, approved 2026-09-17 as initial product policy) --------------------------

// .2026-09-24.1: adds INTELLIGENCE_DIGESTS (Loop Intelligence PR A). Every earlier window is unchanged.
// .2026-09-26.1: adds INTELLIGENCE_LINKS and INTELLIGENCE_REFRESH_REQUESTS (Loop Intelligence PR 2, the
// fabric) for a person's own entity links and refresh requests. Every earlier window is unchanged.
export const WORK_RETENTION_POLICY_VERSION = 'work-retention.2026-09-26.1';

/**
 * How long each category is kept, and why.
 *
 *   days              a number of days, counted from the category's own anchor.
 *   NEVER_STORED      nothing to delete, because nothing is written.
 *   TIED_TO_PARENT    lives and dies with the conclusion it supports.
 *   GOVERNED_ELSEWHERE  another policy owns it (audit).
 *
 * THESE ARE POLICY, NOT CONSTANTS OF NATURE. Changing one is a product decision, recorded in
 * the architecture record with a date -- and an organization may hold a different window
 * through `work_retention_overrides` without this file changing.
 */
export const WORK_RETENTION_RULES = ['DAYS', 'NEVER_STORED', 'TIED_TO_PARENT', 'GOVERNED_ELSEWHERE'] as const;
export type WorkRetentionRule = (typeof WORK_RETENTION_RULES)[number];

export interface WorkRetentionCategory {
  readonly category: string;
  readonly rule: WorkRetentionRule;
  /** Days, when the rule is DAYS. Null otherwise -- never a defaulted number. */
  readonly days: number | null;
  /** What the window is counted from, in words. */
  readonly anchor: string;
  /** The tables this category governs. Every work table appears in exactly one category. */
  readonly tables: readonly string[];
  readonly why: string;
}

export const WORK_RETENTION_CATEGORIES: readonly WorkRetentionCategory[] = Object.freeze([
  Object.freeze({ category: 'GOOGLE_RAW_RESPONSES', rule: 'NEVER_STORED', days: null, anchor: 'not applicable', tables: Object.freeze([]), why: 'Nothing needs the envelope once the fields are normalised.' }),
  Object.freeze({ category: 'GMAIL_METADATA', rule: 'DAYS', days: 30, anchor: 'a voluntary disconnect; kept indefinitely while connected', tables: Object.freeze(['work_messages']), why: "A thread's rhythm needs weeks of history to mean anything." }),
  Object.freeze({ category: 'THREAD_CONTEXT', rule: 'DAYS', days: 90, anchor: 'the last message on the thread', tables: Object.freeze(['work_threads', 'work_correspondents']), why: 'A dormant thread waking up is still recognisable as one that went quiet.' }),
  Object.freeze({ category: 'DRIVE_METADATA', rule: 'DAYS', days: 30, anchor: 'a voluntary disconnect; kept indefinitely while connected', tables: Object.freeze(['work_documents']), why: 'Document context follows the same shape as mail metadata.' }),
  Object.freeze({ category: 'CALENDAR_STATE', rule: 'DAYS', days: 90, anchor: 'the end of the event', tables: Object.freeze(['work_events']), why: 'Meeting briefs need past meetings with the same people.' }),
  Object.freeze({ category: 'DERIVED_WORK_FACTS', rule: 'DAYS', days: 365, anchor: 'the item last changing state', tables: Object.freeze(['work_items', 'work_item_observations', 'work_feedback']), why: 'The accuracy signal needs a year to mean anything.' }),
  Object.freeze({ category: 'MAIL_DRAFTS', rule: 'DAYS', days: 30, anchor: 'the draft last changing, and cleared of its body on send', tables: Object.freeze(['work_drafts']), why: 'An unsent reply is worth keeping while the conversation is live, and worth nothing after.' }),
  Object.freeze({ category: 'BRIEFS', rule: 'DAYS', days: 365, anchor: 'the brief\'s local date', tables: Object.freeze(['work_briefs']), why: '"What happened last week" is the product.' }),
  Object.freeze({ category: 'EVIDENCE_QUOTES', rule: 'TIED_TO_PARENT', days: null, anchor: 'the item that cites it', tables: Object.freeze([]), why: 'An explanation lives exactly as long as the claim it explains.' }),
  Object.freeze({ category: 'PROVENANCE_REFERENCES', rule: 'TIED_TO_PARENT', days: null, anchor: 'the conclusion it supports', tables: Object.freeze([]), why: 'Evidence outliving its conclusion is the rule; the reverse is uninterpretable.' }),
  Object.freeze({ category: 'PROCESSING_CACHE', rule: 'DAYS', days: 1, anchor: 'successful processing, whichever is sooner', tables: Object.freeze([]), why: 'Stage 2 only: deleted on success, with a 24-hour ceiling as a backstop.' }),
  Object.freeze({ category: 'OPERATIONAL_SYNC_STATE', rule: 'DAYS', days: 30, anchor: 'the run starting; cursors live while connected', tables: Object.freeze(['work_sync_runs', 'work_source_cursors']), why: 'Operational only: enough to see a stalled pipeline.' }),
  // Loop Intelligence PR A (approved 2026-09-24): one person's minimized domain intelligence. The
  // window is stamped on each row as `expiresAt` when it is written (intelligence-digest.ts), so an
  // organization override cannot move it; `setRetentionOverride` refuses this category for that reason.
  Object.freeze({ category: 'INTELLIGENCE_DIGESTS', rule: 'DAYS', days: 30, anchor: 'a conversation or thread digest: its newest evidence; a domain rollup: its generation', tables: Object.freeze(['intelligence_digests']), why: 'A reading of a conversation nobody has touched for a month is not current intelligence, and keeping it would be an archive.' }),
  // Loop Intelligence PR 2 (2026-09-26). A person's own explicit entity links (PRINCIPAL rows only; the
  // organization's links name nobody and are the organization's) live as long as the membership.
  Object.freeze({ category: 'INTELLIGENCE_LINKS', rule: 'TIED_TO_PARENT', days: null, anchor: 'the membership', tables: Object.freeze(['entity_links']), why: 'A link a person declared about their own evidence means nothing once they are gone.' }),
  // A refresh request is deleted when it completes; one HELD for an operator is purged a week after it
  // was last touched. Metadata only: a reason, a revision, a fingerprint.
  Object.freeze({ category: 'INTELLIGENCE_REFRESH_REQUESTS', rule: 'DAYS', days: 7, anchor: 'a HELD request last changing; any other request is deleted on completion', tables: Object.freeze(['intelligence_refresh_queue']), why: 'A request is operational state; a week is enough for an operator to see why one was held.' }),
  Object.freeze({ category: 'EMPLOYEE_PREFERENCES', rule: 'TIED_TO_PARENT', days: null, anchor: 'the membership', tables: Object.freeze(['employee_work_preferences', 'work_retention_overrides']), why: "A person's own settings last as long as they are a member." }),
  Object.freeze({ category: 'SECURITY_AUDIT', rule: 'GOVERNED_ELSEWHERE', days: null, anchor: 'not applicable', tables: Object.freeze([]), why: 'Audit records acts, never correspondence, and has its own policy.' }),
]);

/** Deletion at the two ends of a connection, which are different facts (§21.2). */
export const WORK_DISCONNECT_GRACE_DAYS = 30;
export const WORK_TERMINATION_GRACE_DAYS = 0;

// --- Derived (MODEL-produced) items from a background source (§21.2, 2026-09-24) ------------------
//
// A model reads a source's content under an explicit, revocable authorization and writes items
// whose title and evidence are its paraphrases of that content. When the authorization is withdrawn
// those paraphrases are no longer authorized to exist, but the PROVENANCE of the conclusion is
// (ENGINEERING_PRINCIPLES Rule 3): so an item is minimized to the keys below, never edited in place
// to something that still reads as intelligence. The subject prefix is how a withdrawal finds every
// item one provider produced -- the producers and the withdrawal share it here so they cannot drift.

/** The `subjectRef` prefix each provider's MODEL-derived items carry. One entry per provider that produces derived work. */
export const DERIVED_WORK_SUBJECT_PREFIXES = Object.freeze({
  TELEGRAM: 'telegram_conversation:',
} as const);

/** The prefix a provider's derived items carry, or null for a provider that produces none. */
export function derivedWorkSubjectPrefix(provider: string): string | null {
  return (DERIVED_WORK_SUBJECT_PREFIXES as Readonly<Record<string, string>>)[provider] ?? null;
}

/**
 * The reverse lookup: the provider whose derived-subject prefix `subjectRef` carries, or null for any
 * other subject (a Gmail thread id, a calendar event, an empty string). This is how a writer holding
 * only a detection tells an item produced under a revocable content authorization from one that was
 * not -- `WorkItemRepository.detect` re-checks that authorization only when this returns a provider.
 * Matches exactly what a withdrawal's `startsWith` matches, so the two cannot disagree.
 */
export function derivedWorkProviderOf(subjectRef: string): string | null {
  for (const [provider, prefix] of Object.entries(DERIVED_WORK_SUBJECT_PREFIXES)) {
    if (subjectRef.startsWith(prefix)) return provider;
  }
  return null;
}

/** The one `subjectRef` for a Telegram conversation: the keyed conversation, never a raw chat id. */
export function telegramConversationSubjectRef(conversationKey: string): string {
  return `${DERIVED_WORK_SUBJECT_PREFIXES.TELEGRAM}${conversationKey}`;
}

/**
 * The evidence keys that are PROVENANCE, not content: which provider, which keyed message and
 * conversation, which invocation and task version produced the conclusion, whether it was a group,
 * whether the context was truncated. Everything else on a derived item's evidence -- the topic, the
 * next step, the deadline, the category, the counterparty label, anything unknown -- is a paraphrase
 * or a name and is dropped by `minimizeDerivedEvidence`. An ALLOWLIST: a key added to the producer
 * later does not survive a withdrawal unless it is added here on purpose.
 */
export const DERIVED_EVIDENCE_PROVENANCE_KEYS = Object.freeze([
  'provider',
  'providerEventId',
  'conversationKey',
  'aiInvocationId',
  'aiTaskVersion',
  'conversationKind',
  'contextTruncated',
] as const);

/**
 * Reduce a derived item's evidence to provenance plus the fact of the minimization. PURE: the
 * instant is passed in. A value that is not an object yields only the two minimization markers.
 */
export function minimizeDerivedEvidence(evidence: unknown, minimized: { readonly at: Date; readonly reason: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const source = evidence as Record<string, unknown>;
    for (const key of DERIVED_EVIDENCE_PROVENANCE_KEYS) {
      if (key in source) out[key] = source[key];
    }
  }
  out.minimizedAt = minimized.at.toISOString();
  out.minimizedReason = minimized.reason;
  return out;
}

export function workRetentionCategory(category: string): WorkRetentionCategory | null {
  return WORK_RETENTION_CATEGORIES.find((c) => c.category === category) ?? null;
}

/**
 * Every per-person table this retention policy governs. The coverage test walks it against the
 * categories, and the erasure test against what offboarding deletes -- so a table listed here
 * cannot be added without a retention window AND a deletion when the membership ends.
 */
export const WORK_STATE_TABLES: readonly string[] = Object.freeze([
  'work_source_cursors',
  'work_sync_runs',
  'work_correspondents',
  'work_threads',
  'work_messages',
  'work_events',
  'work_documents',
  'work_items',
  'work_item_observations',
  'work_briefs',
  'work_feedback',
  // GM-2: the reply an employee is writing. The one body Loop stores, cleared on send.
  'work_drafts',
  'employee_work_preferences',
  'work_retention_overrides',
  // Loop Intelligence PR A (2026-09-24): principal-private domain intelligence digests.
  'intelligence_digests',
  // Loop Intelligence PR 2 (2026-09-26): a person's own entity links and refresh requests.
  'entity_links',
  'intelligence_refresh_queue',
]);

/** Categories whose window is stamped on the row at write time, so an organization override cannot apply. */
export const WORK_RETENTION_NOT_OVERRIDABLE: readonly string[] = Object.freeze(['INTELLIGENCE_DIGESTS', 'INTELLIGENCE_REFRESH_REQUESTS']);
