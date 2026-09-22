// The worker's HISTORICAL content sweep (v2 conversation triage): a one-off, resumable, TRANSIENT read of
// the ALREADY-IMPORTED recent window (the baseline floor) that surfaces obligations still unresolved
// WITHOUT waiting for a new message. It pages conversations from a checkpoint that is PROVABLY INDEPENDENT
// of every other cursor -- it has NO port that can write the live observation cursor, the baseline
// checkpoint OR the forward content cursor. It advances ONLY the historical* columns.
//
// THREE THINGS MUST HOLD BEFORE ANY BODY IS READ (the same gates the forward sweep enforces):
//   1. historical backfill enabled + not revoked (dueForHistoricalContent returns only those, on a
//      COMPLETE baseline);
//   2. a live, openable credential (openCredential returns non-null);
//   3. the governed gateway's own re-check (activation, budget, authority, routing, output contract).
//
// BOUNDED AND RESUMABLE. Each sweep pages at most `conversationsPerSweep` conversations from the dialog
// frontier and never rereads the whole history. TRANSIENT AI failures (a governed refusal or a transient
// model failure) HOLD the frontier so the page is retried and nothing is silently lost; PERMANENT model
// outcomes (a rejected answer, a model refusal) advance past the conversation and are COUNTED. A FLOOD_WAIT
// holds and backs off. The backfill reaches COMPLETE when the pager reaches the end of the dialog list.
//
// THE BODIES ARE TRANSIENT. Fetched, judged, dropped. Never persisted, never logged, never in a WorkItem or
// its evidence -- the evidence keeps keyed identifiers, the invocation id, the task version, the category,
// a truncation flag, the model's MINIMIZED paraphrase fields (topic, next step, grounded deadline) and the
// ONE label Telegram itself gives the conversation (see buildObligationDetection). Each title is the
// model's minimized paraphrase, never the message; the label is Telegram's, never the model's.

import type { AdapterSession, DueHistoricalContent, HistoricalContentState, WorkItemDetection, WorkPrincipal } from '@emgloop/database';
import { AI_TRIAGE_LIMITS, type ConnectionProvider } from '@emgloop/shared';

import type { TelegramConversationTriageInput, TelegramConversationTriageResult } from '@emgloop/database';
import type { TelegramConversationWindow } from './telegram/telegram-content';
import { buildObligationDetection } from './content-orchestrator';

/** A bounded page of conversations for the historical backfill, each already gathered into its window. */
export interface HistoricalConversationsResult {
  readonly conversations: readonly TelegramConversationWindow[];
  /** The next dialog-pagination frontier. NEVER the live cursor, the baseline checkpoint or the content cursor. */
  readonly nextCursor: string | null;
  /** True when the pager reached the end of the dialog list -> the backfill is COMPLETE. */
  readonly reachedEnd: boolean;
  /** Present when Telegram asked Loop to wait: the frontier holds and the sweep backs off. */
  readonly floodWaitSeconds?: number;
}

/** The adapter capability the historical sweep needs. TelegramAdapter satisfies this structurally. */
export interface HistoricalContentAdapter {
  readonly provider: ConnectionProvider;
  resume(secret: string, binding: { organizationId: string; userId: string }): Promise<AdapterSession>;
  observeHistoricalConversations(
    session: AdapterSession,
    request: { cursor: string | null; floorAt: Date; maxConversations: number; maxWindowMessages: number; tokenBudget: number },
    now: Date,
  ): Promise<HistoricalConversationsResult>;
  disconnect(session: AdapterSession): Promise<void>;
}

/** What one historical run records. NEVER carries the live cursor, the baseline checkpoint or the content cursor. */
export interface HistoricalProgressToRecord {
  readonly historicalCursor: string | null;
  readonly state: HistoricalContentState;
  readonly oldestReachedAt: Date | null;
  readonly failureClass: string | null;
  readonly backoffUntil: Date | null;
  readonly failedItemsDelta: number;
  readonly now: Date;
}

export interface HistoricalContentSweepPorts {
  /** Historical backfills worth a run now (platform-wide; routing fields only). */
  dueForHistoricalContent(): Promise<readonly DueHistoricalContent[]>;
  /** The adapter for a provider, or null when this deployment has none wired. */
  adapterFor(provider: ConnectionProvider): HistoricalContentAdapter | null;
  /** Open the sealed credential for one backfill's connection; null when none is held or it will not open. */
  openCredential(due: DueHistoricalContent): Promise<string | null>;
  readonly conversationSecret: string;
  /** Read ONE conversation window through the governed AI runtime. The bodies reach nothing but that call. */
  triage(principal: WorkPrincipal, input: TelegramConversationTriageInput): Promise<TelegramConversationTriageResult>;
  /** Persist ONE minimized, employee-private obligation WorkItem. No body, ever. */
  raiseWorkItem(principal: WorkPrincipal, detection: WorkItemDetection): Promise<void>;
  /** Close obligations a later message answered (with the reconcile guard). */
  resolveObligations(
    principal: WorkPrincipal,
    subjectRef: string,
    keptAnchorProviderEventIds: readonly string[],
    evaluatedFloorProviderEventId: string,
    occurredAt: Date,
  ): Promise<void>;
  /** Advance (or hold) ONLY the historical* columns. MUST NOT touch the other three cursors. */
  recordHistoricalProgress(due: DueHistoricalContent, progress: HistoricalProgressToRecord): Promise<void>;
  /** How many conversations one historical sweep pages per backfill (bounded, never the whole history). */
  readonly conversationsPerSweep: number;
  now(): Date;
}

export interface HistoricalContentSweepSummary {
  readonly due: number;
  readonly advanced: number;
  readonly completed: number;
  readonly skipped: number;
  readonly held: number;
  readonly raised: number;
  readonly reconciled: number;
  readonly failedItems: number;
  readonly floodWaits: number;
}

/** Run one historical content sweep over all due backfills. Never throws for a single backfill. */
export async function runHistoricalContentSweep(ports: HistoricalContentSweepPorts): Promise<HistoricalContentSweepSummary> {
  const due = await ports.dueForHistoricalContent();
  const now = ports.now();
  let advanced = 0;
  let completed = 0;
  let skipped = 0;
  let held = 0;
  let raised = 0;
  let reconciled = 0;
  let failedItems = 0;
  let floodWaits = 0;

  for (const item of due) {
    try {
      const adapter = ports.adapterFor(item.provider);
      if (!adapter) {
        skipped += 1;
        continue;
      }
      const secret = await ports.openCredential(item);
      if (secret === null) {
        skipped += 1;
        continue;
      }

      let session: AdapterSession;
      try {
        session = await adapter.resume(secret, { organizationId: item.organizationId, userId: item.userId });
      } catch {
        await ports.recordHistoricalProgress(item, holdHistorical(item.historicalCursor, 'AUTH', null, now));
        held += 1;
        continue;
      }

      let page: HistoricalConversationsResult;
      try {
        page = await adapter.observeHistoricalConversations(
          session,
          {
            cursor: item.historicalCursor,
            floorAt: item.historicalWindowFloorAt,
            maxConversations: ports.conversationsPerSweep,
            maxWindowMessages: AI_TRIAGE_LIMITS.maxWindowMessages,
            tokenBudget: AI_TRIAGE_LIMITS.maxContextInputTokens,
          },
          now,
        );
      } catch {
        await ports.recordHistoricalProgress(item, holdHistorical(item.historicalCursor, 'TRANSIENT', null, now));
        held += 1;
        await adapter.disconnect(session).catch(() => undefined);
        continue;
      }
      await adapter.disconnect(session).catch(() => undefined);

      if (page.floodWaitSeconds !== undefined) {
        const backoffUntil = new Date(now.getTime() + Math.max(0, page.floodWaitSeconds) * 1000);
        await ports.recordHistoricalProgress(item, holdHistorical(item.historicalCursor, 'FLOOD_WAIT', backoffUntil, now));
        held += 1;
        floodWaits += 1;
        continue;
      }

      const outcome = await processHistoricalPage(ports, item, page, now);
      raised += outcome.raised;
      reconciled += outcome.reconciled;
      failedItems += outcome.failedItemsDelta;

      if (outcome.hold) {
        // Transient (a governed refusal or a transient model failure): HOLD the frontier and retry the
        // page. Any obligations already raised are idempotent; nothing is silently lost.
        await ports.recordHistoricalProgress(item, {
          historicalCursor: item.historicalCursor,
          state: 'IN_PROGRESS',
          oldestReachedAt: outcome.oldestReachedAt,
          failureClass: outcome.failureClass,
          backoffUntil: null,
          failedItemsDelta: outcome.failedItemsDelta,
          now,
        });
        held += 1;
        continue;
      }

      const state: HistoricalContentState = page.reachedEnd ? 'COMPLETE' : 'IN_PROGRESS';
      await ports.recordHistoricalProgress(item, {
        historicalCursor: page.nextCursor,
        state,
        oldestReachedAt: outcome.oldestReachedAt,
        failureClass: null,
        backoffUntil: null,
        failedItemsDelta: outcome.failedItemsDelta,
        now,
      });
      advanced += 1;
      if (state === 'COMPLETE') completed += 1;
    } catch {
      held += 1;
    }
  }

  return { due: due.length, advanced, completed, skipped, held, raised, reconciled, failedItems, floodWaits };
}

interface HistoricalPageOutcome {
  readonly raised: number;
  readonly reconciled: number;
  readonly failedItemsDelta: number;
  readonly hold: boolean;
  readonly failureClass: string | null;
  readonly oldestReachedAt: Date | null;
}

/**
 * Triage each conversation in the page. A TRANSIENT failure (governed refusal or a transient model
 * failure) HOLDS the page (the frontier does not advance, so it is retried); a PERMANENT model outcome (a
 * rejected answer or a model refusal) advances past the conversation and is COUNTED. Obligations are
 * raised, then reconciled (with the guard).
 */
async function processHistoricalPage(
  ports: HistoricalContentSweepPorts,
  item: DueHistoricalContent,
  page: HistoricalConversationsResult,
  now: Date,
): Promise<HistoricalPageOutcome> {
  const principal: WorkPrincipal = { organizationId: item.organizationId, userId: item.userId };
  let raised = 0;
  let reconciled = 0;
  let failedItemsDelta = 0;
  let oldestReachedMs: number | null = null;

  for (const window of page.conversations) {
    for (const message of window.messages) {
      const ms = message.occurredAt.getTime();
      if (oldestReachedMs === null || ms < oldestReachedMs) oldestReachedMs = ms; // content-free progress
    }
    if (window.messages.length === 0) continue;

    const truncated = window.truncation.reason !== 'NONE';
    const result = await ports.triage(principal, {
      conversationKey: window.conversationKey,
      messages: window.messages,
      truncated,
      evaluatedFloorProviderEventId: window.truncation.oldestIncludedProviderEventId ?? '',
      conversation: window.conversation,
    });

    if (result.outcome === 'NOT_AVAILABLE') {
      // Deployment-level (all-or-nothing): HOLD the whole page, retry when configured.
      return { raised, reconciled, failedItemsDelta, hold: true, failureClass: 'REFUSED_BY_LOOP', oldestReachedAt: oldestReachedOf(oldestReachedMs) };
    }
    if (result.outcome === 'FAILED') {
      // A transient model/runtime failure: HOLD the page so this conversation is retried, never lost.
      return { raised, reconciled, failedItemsDelta, hold: true, failureClass: 'TRANSIENT', oldestReachedAt: oldestReachedOf(oldestReachedMs) };
    }
    if (result.outcome === 'REJECTED_OUTPUT' || result.outcome === 'REFUSED_BY_MODEL') {
      // Permanent for this content: advance past it and COUNT it (never silently lost).
      failedItemsDelta += 1;
      continue;
    }

    // TRIAGED: raise obligations, then reconcile (close what a later message answered, within the window).
    const subjectRef = `telegram_conversation:${window.conversationKey}`;
    for (const obligation of result.items) {
      await ports.raiseWorkItem(principal, buildObligationDetection(window, obligation, result.provenance, truncated, now));
      raised += 1;
    }
    await ports.resolveObligations(principal, subjectRef, result.items.map((o) => o.anchorProviderEventId), result.evaluatedFloorProviderEventId, now);
    reconciled += 1;
  }

  return { raised, reconciled, failedItemsDelta, hold: false, failureClass: null, oldestReachedAt: oldestReachedOf(oldestReachedMs) };
}

function oldestReachedOf(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

/** A progress record that HOLDS the historical frontier where it is (never advances it). */
function holdHistorical(cursor: string | null, failureClass: string, backoffUntil: Date | null, now: Date): HistoricalProgressToRecord {
  return { historicalCursor: cursor, state: 'IN_PROGRESS', oldestReachedAt: null, failureClass, backoffUntil, failedItemsDelta: 0, now };
}
