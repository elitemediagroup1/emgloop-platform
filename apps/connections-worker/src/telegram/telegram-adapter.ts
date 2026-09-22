// The Telegram ConnectionAdapter: resume an authorized MTProto session, observe incrementally,
// walk a bounded history baseline, disconnect. It depends on a TelegramClientPort (the MTProto
// client), NOT on gramjs directly, so the adapter's policy -- what an auth failure is, how a cursor
// advances, what "observing" means, where a backward walk stops -- is pure and fully testable, while
// the live client is a thin seam (telegram-client.ts).
//
// AN INTELLIGENCE SOURCE, NOT A CLIENT. This adapter OBSERVES and NORMALIZES; it has no send, reply,
// react, edit or delete -- Telegram stays the place the conversation happens. observe() and
// observeHistory() both turn the client's raw messages into content-free ConversationEvents through
// the ONE mapping (content-free-mapping.ts); the adapter itself never touches text, media or names.
//
// This is the OFFICIAL USER CLIENT route (MTProto), not a bot. Auth INITIATION (the phone-code
// exchange) is out of band and lives in the login flow, not here: resume() only restores an
// already-authorized session from the unsealed session string.

import type { AdapterSession, ConnectionAdapter, ObservationResult } from '@emgloop/database';
import type { CapabilityStatus } from '@emgloop/shared';

import type { TelegramConversationKind } from '@emgloop/database';

import { telegramCursorAfter, telegramMessageToConversationEvent, type TelegramMessageFacts } from './content-free-mapping';
import { gatherConversationWindow, telegramContentCursorAfter, type TelegramContentMessage, type TelegramConversationWindow } from './telegram-content';
import type { BaselineObservationResult } from '../baseline-orchestrator';
import type { ContentObservationResult, ContentWindowResult } from '../content-orchestrator';
import type { HistoricalConversationsResult } from '../historical-content-orchestrator';

/** Raw candidates fetched per dialog for the adaptive window. Larger than the count cap so the window's own bounds bind. */
const WINDOW_FETCH_LIMIT = 200;

/**
 * How the provider describes ONE conversation: its display label as the person sees it in Telegram (a
 * contact's name, a group's title) and whether it is a private chat or a group. RAW here; the adaptive
 * window minimizes it, and nothing keeps the raw value.
 */
export interface TelegramDialogDescription {
  readonly label: string | null;
  readonly kind: TelegramConversationKind | null;
}

/** A bounded page of conversations from the historical dialog frontier, each with its raw content candidates. */
export interface TelegramHistoricalDialogsPage {
  readonly dialogs: readonly {
    readonly chatId: string;
    readonly messages: readonly TelegramContentMessage[];
    /** The provider's description of the dialog, when it had one. Minimized downstream, never stored raw. */
    readonly description?: TelegramDialogDescription | null;
  }[];
  /** The next dialog-pagination frontier. NEVER the live cursor, the baseline checkpoint or the forward contentCursor. */
  readonly nextCursor: string | null;
  /** True when the pager reached the end of the dialog list (no more conversations to page). */
  readonly reachedEnd: boolean;
}

/** A stale or invalid MTProto session. Named so runConnectionCycle classifies it as auth loss. */
export class TelegramAuthError extends Error {
  constructor(message = 'telegram session is no longer authorized') {
    super(message);
    this.name = 'TelegramAuthError';
  }
}

/** Telegram asked Loop to wait before making more requests. Carries only the wait, never a code/session. */
export class TelegramFloodWaitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('telegram flood wait');
    this.name = 'TelegramFloodWaitError';
  }
}

/** One backward history page request: older than `beforeId`, no earlier than `floorAt`, at most `limit`. */
export interface TelegramHistoryPageRequest {
  readonly beforeId: number | null;
  readonly floorAt: Date;
  readonly limit: number;
}

/** The MTProto client, as the adapter needs it. The gramjs binding implements this. */
export interface TelegramClientPort {
  /** Restore a client from the unsealed session string. Throws TelegramAuthError if it is stale. */
  connectFromSession(session: string, binding: { organizationId: string; userId: string }): Promise<TelegramClientHandle>;
  /** Message metadata since `cursor` (a message id), oldest first. Content-free facts only. */
  fetchSince(handle: TelegramClientHandle, cursor: string | null, now: Date): Promise<readonly TelegramMessageFacts[]>;
  /**
   * Message metadata walking BACKWARD from the checkpoint offset to the floor. Content-free facts only,
   * never below the floor. Throws TelegramFloodWaitError when Telegram asks Loop to wait. Used ONLY by
   * the baseline; it never advances the live observation cursor.
   */
  fetchHistory(handle: TelegramClientHandle, request: TelegramHistoryPageRequest): Promise<readonly TelegramMessageFacts[]>;
  /**
   * Message CONTENT since `cursor` (a message id), oldest first, bounded by `limit`. TRANSIENT: the
   * bodies are judged by the triage service and dropped, never persisted. Used ONLY by the content
   * sweep; it never advances the live observation cursor or the baseline checkpoint. Throws
   * TelegramFloodWaitError when Telegram asks Loop to wait.
   */
  fetchContentSince(handle: TelegramClientHandle, cursor: string | null, limit: number, now: Date): Promise<readonly TelegramContentMessage[]>;
  /**
   * Raw CONTENT candidates for ONE conversation, NEWEST FIRST, for the adaptive window (v2). TRANSIENT
   * bodies, at most `limit`, no older than `floorAt`. Used by the forward window build. Throws
   * TelegramFloodWaitError when Telegram asks Loop to wait; it advances no cursor.
   */
  fetchDialogWindow(handle: TelegramClientHandle, request: { chatId: string; floorAt: Date; limit: number }, now: Date): Promise<readonly TelegramContentMessage[]>;
  /**
   * A bounded PAGE of conversations from the historical dialog frontier, each with its raw CONTENT
   * candidates (NEWEST FIRST, transient). Skips conversations with no activity after `floorAt`. It
   * advances ONLY the dialog-pagination frontier, never any other cursor. Throws TelegramFloodWaitError
   * when Telegram asks Loop to wait.
   */
  fetchHistoricalDialogs(handle: TelegramClientHandle, request: { cursor: string | null; floorAt: Date; maxConversations: number; perDialogLimit: number }, now: Date): Promise<TelegramHistoricalDialogsPage>;
  /**
   * How Telegram describes ONE conversation (its display label and whether it is a private chat or a
   * group), for the forward window. Optional and best-effort: a client without it, or one that fails,
   * yields NO label -- a review never waits on a label and a label is never invented.
   */
  describeDialog?(handle: TelegramClientHandle, chatId: string, now: Date): Promise<TelegramDialogDescription | null>;
  /** Close the socket. Never modifies the Telegram account. */
  close(handle: TelegramClientHandle): Promise<void>;
  /** Revoke this authorization at Telegram (used only by disconnect). Optional; best-effort. */
  logOut?(handle: TelegramClientHandle): Promise<void>;
}

export interface TelegramClientHandle {
  readonly kind: 'telegram-mtproto';
  readonly client: unknown;
}

/**
 * The next BACKWARD offset after a history page: the LOWEST message id seen, as a string. Baseline
 * walks toward older messages, so the minimum is the "seen back to here" point. Holds at the previous
 * offset when the batch is empty. This is a checkpoint offset, NEVER the live observation cursor.
 */
export function telegramHistoryCursorBefore(previous: number | null, batch: readonly TelegramMessageFacts[]): string | null {
  let min = previous ?? Number.POSITIVE_INFINITY;
  for (const f of batch) {
    const n = Number(f.messageId);
    if (Number.isFinite(n) && n < min) min = n;
  }
  if (Number.isFinite(min)) return String(min);
  return previous !== null ? String(previous) : null;
}

/** The oldest occurredAt in a batch as an ISO instant, or null when the batch is empty. */
export function oldestOccurredAt(batch: readonly TelegramMessageFacts[]): string | null {
  let oldest: number | null = null;
  for (const f of batch) {
    const ms = f.dateSeconds * 1000;
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

export class TelegramAdapter implements ConnectionAdapter {
  readonly provider = 'TELEGRAM' as const;
  private readonly port: TelegramClientPort;
  private readonly conversationSecret: string;

  constructor(deps: { port: TelegramClientPort; conversationSecret: string }) {
    this.port = deps.port;
    this.conversationSecret = deps.conversationSecret;
  }

  async resume(secret: string, binding: { organizationId: string; userId: string }): Promise<AdapterSession> {
    const handle = await this.port.connectFromSession(secret, binding);
    return { provider: this.provider, handle };
  }

  async observe(session: AdapterSession, cursor: string | null, now: Date): Promise<ObservationResult> {
    const handle = session.handle as TelegramClientHandle;
    const batch = await this.port.fetchSince(handle, cursor, now);
    const events = batch.map((facts) => telegramMessageToConversationEvent(facts, { secret: this.conversationSecret, observedAt: now, cursor: null }));
    const nextCursor = telegramCursorAfter(cursor, batch);
    // Reaching this point means the client answered: background observation is operational.
    const backgroundObservation: CapabilityStatus = 'OPERATIONAL';
    return { events, cursor: nextCursor, backgroundObservation };
  }

  /**
   * One backward history page for the baseline. Fetches metadata older than the checkpoint offset and
   * no earlier than the window floor, maps it to content-free events (the SAME mapping observe uses),
   * and reports the next backward offset, how far back it reached, and whether the floor is reached.
   *
   * FLOOR AND TERMINATION. It keeps only messages within the window AND strictly older than the offset,
   * so the walk always moves backward and terminates. A page shorter than `pageSize` means the floor
   * (or the end of history) was reached -> reachedFloor. A FLOOD_WAIT holds the checkpoint: no events,
   * the offset unchanged, and the wait reported so the caller can back off. It NEVER touches the live cursor.
   */
  async observeHistory(
    session: AdapterSession,
    opts: { readonly checkpointCursor: string | null; readonly windowFloorAt: Date; readonly pageSize: number },
    now: Date,
  ): Promise<BaselineObservationResult> {
    const handle = session.handle as TelegramClientHandle;
    const beforeId = opts.checkpointCursor ? Number(opts.checkpointCursor) : null;
    const pageSize = Math.max(1, opts.pageSize);
    let batch: readonly TelegramMessageFacts[];
    try {
      batch = await this.port.fetchHistory(handle, { beforeId, floorAt: opts.windowFloorAt, limit: pageSize });
    } catch (err) {
      if (err instanceof TelegramFloodWaitError) {
        return { events: [], nextCursor: opts.checkpointCursor, oldestReachedAt: null, reachedFloor: false, floodWaitSeconds: err.retryAfterSeconds };
      }
      throw err;
    }
    const floorMs = opts.windowFloorAt.getTime();
    const withinWindow = batch.filter((f) => {
      if (f.dateSeconds * 1000 < floorMs) return false; // below the floor: out of window
      if (beforeId !== null && !(Number(f.messageId) < beforeId)) return false; // must move backward
      return true;
    });
    const events = withinWindow.map((facts) => telegramMessageToConversationEvent(facts, { secret: this.conversationSecret, observedAt: now, cursor: null }));
    const nextCursor = telegramHistoryCursorBefore(beforeId, withinWindow);
    const reachedFloor = withinWindow.length < pageSize; // a short page: the floor or the end of history
    return { events, nextCursor, oldestReachedAt: oldestOccurredAt(withinWindow), reachedFloor };
  }

  /**
   * One bounded page of NEW message CONTENT for the content sweep, read TRANSIENTLY. It fetches message
   * bodies newer than the content cursor (a message id), oldest first, at most `limit`, and reports the
   * next content cursor. It maps NOTHING to a ConversationEvent and persists NOTHING: the bodies flow to
   * the triage service and are dropped. A FLOOD_WAIT yields no messages, the cursor unchanged, and the
   * wait reported so the caller can back off. It NEVER touches the live observation cursor or the baseline.
   */
  async observeContent(session: AdapterSession, cursor: string | null, limit: number, now: Date): Promise<ContentObservationResult> {
    const handle = session.handle as TelegramClientHandle;
    let batch: readonly TelegramContentMessage[];
    try {
      batch = await this.port.fetchContentSince(handle, cursor, Math.max(1, limit), now);
    } catch (err) {
      if (err instanceof TelegramFloodWaitError) {
        return { messages: [], nextCursor: cursor, floodWaitSeconds: err.retryAfterSeconds };
      }
      throw err;
    }
    return { messages: batch, nextCursor: telegramContentCursorAfter(cursor, batch) };
  }

  /**
   * Build the ADAPTIVE conversation window for ONE conversation (v2), read TRANSIENTLY. It fetches raw
   * candidate messages (newest first) for the chat and gathers them through the pure adaptive window
   * (skip empty/non-text, never cross the floor, stop at the count cap or the input-token budget, return
   * chronological). It maps NOTHING to a ConversationEvent and persists NOTHING: the bodies flow to the
   * triage service and are dropped. A FLOOD_WAIT yields an empty window and the wait, so the caller can
   * back off. It NEVER touches the live observation cursor, the baseline checkpoint or the content cursor.
   */
  async fetchConversationWindow(
    session: AdapterSession,
    request: { readonly chatId: string; readonly floorAt: Date; readonly maxMessages: number; readonly tokenBudget: number },
    now: Date,
  ): Promise<ContentWindowResult> {
    const handle = session.handle as TelegramClientHandle;
    let candidates: readonly TelegramContentMessage[];
    try {
      candidates = await this.port.fetchDialogWindow(handle, { chatId: request.chatId, floorAt: request.floorAt, limit: WINDOW_FETCH_LIMIT }, now);
    } catch (err) {
      if (err instanceof TelegramFloodWaitError) return { window: emptyWindow(request.chatId, this.conversationSecret), floodWaitSeconds: err.retryAfterSeconds };
      throw err;
    }
    // The label is best-effort and never blocks the review: a client without `describeDialog`, or one
    // that fails, means no label -- and no label is ever invented.
    let description: TelegramDialogDescription | null = null;
    if (this.port.describeDialog) {
      try {
        description = await this.port.describeDialog(handle, request.chatId, now);
      } catch {
        description = null;
      }
    }
    const window = gatherConversationWindow(request.chatId, candidates, this.conversationSecret, {
      floorAt: request.floorAt,
      maxMessages: request.maxMessages,
      tokenBudget: request.tokenBudget,
      conversation: description,
    });
    return { window };
  }

  /**
   * One bounded PAGE of conversations for the HISTORICAL backfill, each already gathered into its adaptive
   * window (v2), read TRANSIENTLY. It pages conversations from the historical dialog frontier, skipping
   * conversations inactive after the floor, and gathers each one's window through the SAME pure adaptive
   * window the forward path uses. It persists NOTHING. A FLOOD_WAIT yields no conversations, the frontier
   * unchanged, and the wait so the caller can back off. It NEVER touches the live cursor, the baseline
   * checkpoint or the forward content cursor -- it reports only the dialog-pagination frontier to advance.
   */
  async observeHistoricalConversations(
    session: AdapterSession,
    request: {
      readonly cursor: string | null;
      readonly floorAt: Date;
      readonly maxConversations: number;
      readonly maxWindowMessages: number;
      readonly tokenBudget: number;
    },
    now: Date,
  ): Promise<HistoricalConversationsResult> {
    const handle = session.handle as TelegramClientHandle;
    let page: TelegramHistoricalDialogsPage;
    try {
      page = await this.port.fetchHistoricalDialogs(
        handle,
        { cursor: request.cursor, floorAt: request.floorAt, maxConversations: request.maxConversations, perDialogLimit: WINDOW_FETCH_LIMIT },
        now,
      );
    } catch (err) {
      if (err instanceof TelegramFloodWaitError) return { conversations: [], nextCursor: request.cursor, reachedEnd: false, floodWaitSeconds: err.retryAfterSeconds };
      throw err;
    }
    const conversations = page.dialogs
      .map((dialog) =>
        gatherConversationWindow(dialog.chatId, dialog.messages, this.conversationSecret, {
          floorAt: request.floorAt,
          maxMessages: request.maxWindowMessages,
          tokenBudget: request.tokenBudget,
          conversation: dialog.description ?? null,
        }),
      )
      // A conversation with no text in the window (all media, or all below the floor) has nothing to triage.
      .filter((window) => window.messages.length > 0);
    return { conversations, nextCursor: page.nextCursor, reachedEnd: page.reachedEnd };
  }

  async disconnect(session: AdapterSession): Promise<void> {
    await this.port.close(session.handle as TelegramClientHandle);
  }
}

/** An empty window for a flood/skip, so the conversationKey stays keyed and no body is ever fabricated. */
function emptyWindow(chatId: string, conversationSecret: string): TelegramConversationWindow {
  const conversationKey = gatherConversationWindow(chatId, [], conversationSecret, {
    floorAt: new Date(0),
    maxMessages: 1,
    tokenBudget: 0,
  }).conversationKey;
  return { conversationKey, conversation: { label: null, kind: null }, messages: [], truncation: { includedCount: 0, reason: 'NONE', oldestIncludedProviderEventId: null } };
}
