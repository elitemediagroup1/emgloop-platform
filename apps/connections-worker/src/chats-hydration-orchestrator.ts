// CHATS INTELLIGENCE INITIALIZATION ("hydration", 2026-09-25): a DIGEST-ONLY, one-off, resumable pass
// that gives an already-authorized person a CHATS digest for each recent conversation WITHOUT waiting for a
// new message.
//
// WHY IT EXISTS. The historical content backfill is one-shot per authorization. Authorizations that
// completed it before Chats Intelligence (#338) never become due again, so their conversations had no
// digest until a new message crossed the forward cursor. Re-arming that backfill would replay obligation
// detection (WorkItemRepository.detect re-sights: bumps counts, refreshes title and evidence) and
// reconciliation (resolveObligationsNotIn may supersede still-open items) -- unsafe. So this pass is a
// thin sibling that REUSES the backfill's pager (observeHistoricalConversations), the adaptive window, the
// SAME governed `telegram.content.triage` invocation and the SAME digest builder and write path
// (recordConversationReading -> IntelligenceDigestRepository.upsert, consent re-checked in the write).
//
// DIGEST-ONLY IS STRUCTURAL. These ports have NO raiseWorkItem and NO resolveObligations: the obligations
// in the answer are dropped, nothing is reconciled, and no WorkItem or observation can be written from
// here. The historical backfill and the forward sweep own obligations. (Pinned by tests.)
//
// WHAT IS READ, AND WHAT IS NOT CALLED. For each conversation in a page:
//   (a) its newest message is older than the digest retention (a digest would be EXPIRED_AT_WRITE) or the
//       baseline floor -> skipped, NO model call. The pager is also handed the later of the two floors, so
//       a dialog inactive since then is never even fetched;
//   (b) the person already holds a current (non-withdrawn, unexpired) digest of it -> skipped, NO model
//       call: the forward path owns updates;
//   (c) otherwise ONE triage call, and ONLY its conversation reading is stored.
//
// BOUNDED. At most `conversationsPerSweep` model calls per authorization per sweep (each page asks for at
// most the calls still allowed, so a page can never need more), at most HYDRATION_MAX_PAGES_PER_SWEEP
// pages. BUDGET RESERVE: before every call the organization's telegram.content.triage headroom (the
// tightest daily invocation window, from the durable ledger) is read; at or below `budgetReserve` the pass
// STOPS and holds (HYDRATION_BUDGET_RESERVE) so forward triage always keeps room. The gateway's own
// budget refusal remains authoritative on top.
//
// CURSOR SEMANTICS mirror the historical sweep. TRANSIENT (a thrown page read, a FAILED model call, a
// governed refusal, the budget reserve, a digest write that throws) -> HOLD the frontier of the page in
// hand (conversations already given a digest are skipped by (b) on the retry, at no model cost);
// FLOOD_WAIT -> hold + back off; REJECTED_OUTPUT / REFUSED_BY_MODEL -> advance, COUNT it (no hot loop --
// forward triage reads it when a new message arrives); consent or membership ended at the write -> stop
// this authorization and hold; the pager reaching the end of the dialog list -> COMPLETE, recording the
// triage schema it covered. Everything resumes from the persisted cursor/state: a COMPLETE hydration is
// never due again.
//
// THE BODIES ARE TRANSIENT: fetched, judged, dropped -- never persisted, never logged. The summary is
// counts only.

import {
  TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID,
  type AdapterSession,
  type ChatsHydrationState,
  type DueChatsHydration,
  type IntelligenceDigestInput,
  type TelegramConversationTriageInput,
  type TelegramConversationTriageResult,
  type WorkPrincipal,
} from '@emgloop/database';
import {
  AI_TRIAGE_LIMITS,
  INTELLIGENCE_DIGEST_SUBJECT_RETENTION_DAYS,
  intelligenceDigestExpiresAt,
  telegramConversationSubjectRef,
  type ConnectionProvider,
} from '@emgloop/shared';

import { recordConversationReading, refusalFailureClass, type ConversationIntelligenceWrite, type DigestTally } from './content-orchestrator';
import type { HistoricalContentAdapter, HistoricalConversationsResult } from './historical-content-orchestrator';
import type { TelegramConversationWindow } from './telegram/telegram-content';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pages one hydration sweep may read per authorization (a page of skipped conversations costs no model call). */
export const HYDRATION_MAX_PAGES_PER_SWEEP = 10;

/** The failure class recorded when the budget reserve stopped the pass. */
export const HYDRATION_BUDGET_RESERVE = 'HYDRATION_BUDGET_RESERVE';

/** What one hydration run records. ONLY the intelligenceHydration* columns -- never any other cursor. */
export interface ChatsHydrationProgressToRecord {
  readonly cursor: string | null;
  readonly state: ChatsHydrationState;
  readonly failureClass: string | null;
  readonly backoffUntil: Date | null;
  readonly failedItemsDelta: number;
  /** Set only with COMPLETE: the triage output schema the completed hydration covered. */
  readonly schemaId: string | null;
  readonly now: Date;
}

export interface ChatsHydrationSweepPorts {
  /** Hydrations worth a run now (platform-wide; routing fields only). */
  dueForChatsHydration(): Promise<readonly DueChatsHydration[]>;
  /** The adapter for a provider, or null when this deployment has none wired. */
  adapterFor(provider: ConnectionProvider): HistoricalContentAdapter | null;
  /** Open the sealed credential; null when none is held or it will not open (the same gate as the backfill). */
  openCredential(due: DueChatsHydration): Promise<string | null>;
  /** The SAME governed triage call the other sweeps make. The bodies reach nothing but that call. */
  triage(principal: WorkPrincipal, input: TelegramConversationTriageInput): Promise<TelegramConversationTriageResult>;
  /** True when this person already holds a current (non-withdrawn, unexpired) CHATS digest of the conversation. */
  hasCurrentConversationDigest(principal: WorkPrincipal, subjectRef: string, now: Date): Promise<boolean>;
  /** Store ONE conversation's reading as the person's CHATS digest. Throws on a database failure. */
  recordConversationIntelligence(principal: WorkPrincipal, digest: IntelligenceDigestInput): Promise<ConversationIntelligenceWrite>;
  /** The organization's telegram.content.triage invocation headroom now (tightest daily window). */
  triageHeadroom(organizationId: string, now: Date): Promise<number>;
  /** Advance (or hold) ONLY the intelligenceHydration* columns. */
  recordChatsHydrationProgress(due: DueChatsHydration, progress: ChatsHydrationProgressToRecord): Promise<void>;
  /** At most this many model calls per authorization per sweep. */
  readonly conversationsPerSweep: number;
  /** Stop when the headroom is at or below this many invocations. */
  readonly budgetReserve: number;
  now(): Date;
}

export interface ChatsHydrationSweepSummary {
  readonly due: number;
  readonly pages: number;
  readonly skipped: number;
  readonly skippedOld: number;
  readonly skippedHasDigest: number;
  readonly invoked: number;
  readonly digestsWritten: number;
  readonly digestsUnchanged: number;
  readonly digestsRefused: number;
  readonly failedItems: number;
  readonly advanced: number;
  readonly completed: number;
  readonly held: number;
  readonly floodWaits: number;
  /** Holds by failure class (a fixed, content-free vocabulary). Counts only. */
  readonly heldBy: Readonly<Record<string, number>>;
}

interface Counters {
  pages: number;
  skippedOld: number;
  skippedHasDigest: number;
  invoked: number;
  failedItems: number;
}

/** Run one hydration sweep over all due authorizations. Never throws for a single authorization. */
export async function runChatsHydrationSweep(ports: ChatsHydrationSweepPorts): Promise<ChatsHydrationSweepSummary> {
  const due = await ports.dueForChatsHydration();
  const now = ports.now();
  const counters: Counters = { pages: 0, skippedOld: 0, skippedHasDigest: 0, invoked: 0, failedItems: 0 };
  const tally: DigestTally = { written: 0, unchanged: 0, refused: 0 };
  const heldBy: Record<string, number> = {};
  let skipped = 0;
  let advanced = 0;
  let completed = 0;
  let held = 0;
  let floodWaits = 0;

  const hold = async (item: DueChatsHydration, cursor: string | null, failureClass: string, backoffUntil: Date | null, failedItemsDelta: number) => {
    held += 1;
    heldBy[failureClass] = (heldBy[failureClass] ?? 0) + 1;
    await ports.recordChatsHydrationProgress(item, { cursor, state: 'IN_PROGRESS', failureClass, backoffUntil, failedItemsDelta, schemaId: null, now });
  };

  for (const item of due) {
    // The frontier this sweep has durably reached for this authorization (a page fully processed).
    let cursor = item.hydrationCursor;
    let failedDelta = 0;
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
        await hold(item, cursor, 'AUTH', null, 0);
        continue;
      }

      const principal: WorkPrincipal = { organizationId: item.organizationId, userId: item.userId };
      // The pager's floor: the later of the baseline floor and the digest retention horizon, so a dialog
      // inactive since then is not fetched at all.
      const retentionFloor = new Date(now.getTime() - INTELLIGENCE_DIGEST_SUBJECT_RETENTION_DAYS * DAY_MS);
      const floorAt = item.historicalWindowFloorAt.getTime() > retentionFloor.getTime() ? item.historicalWindowFloorAt : retentionFloor;
      let callsLeft = Math.max(1, ports.conversationsPerSweep);
      let outcome: { kind: 'CONTINUE' } | { kind: 'COMPLETE' } | { kind: 'HOLD'; failureClass: string; backoffUntil: Date | null } = { kind: 'CONTINUE' };

      try {
        for (let pageIndex = 0; pageIndex < HYDRATION_MAX_PAGES_PER_SWEEP && callsLeft > 0; pageIndex += 1) {
          let page: HistoricalConversationsResult;
          try {
            page = await adapter.observeHistoricalConversations(
              session,
              {
                cursor,
                floorAt,
                // Never more conversations than calls still allowed: a page can never need more.
                maxConversations: callsLeft,
                maxWindowMessages: AI_TRIAGE_LIMITS.maxWindowMessages,
                tokenBudget: AI_TRIAGE_LIMITS.maxContextInputTokens,
              },
              now,
            );
          } catch {
            outcome = { kind: 'HOLD', failureClass: 'TRANSIENT', backoffUntil: null };
            break;
          }
          if (page.floodWaitSeconds !== undefined) {
            floodWaits += 1;
            outcome = { kind: 'HOLD', failureClass: 'FLOOD_WAIT', backoffUntil: new Date(now.getTime() + Math.max(0, page.floodWaitSeconds) * 1000) };
            break;
          }
          counters.pages += 1;
          const result = await hydratePage(ports, item, principal, page.conversations, now, counters, tally);
          failedDelta += result.failedItemsDelta;
          callsLeft -= result.invoked;
          if (result.hold) {
            outcome = { kind: 'HOLD', failureClass: result.hold, backoffUntil: null };
            break;
          }
          cursor = page.nextCursor;
          if (page.reachedEnd) {
            outcome = { kind: 'COMPLETE' };
            break;
          }
        }
      } finally {
        await adapter.disconnect(session).catch(() => undefined);
      }

      counters.failedItems += failedDelta;
      if (outcome.kind === 'HOLD') {
        await hold(item, cursor, outcome.failureClass, outcome.backoffUntil, failedDelta);
        continue;
      }
      const state: ChatsHydrationState = outcome.kind === 'COMPLETE' ? 'COMPLETE' : 'IN_PROGRESS';
      await ports.recordChatsHydrationProgress(item, {
        cursor,
        state,
        failureClass: null,
        backoffUntil: null,
        failedItemsDelta: failedDelta,
        schemaId: state === 'COMPLETE' ? TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID : null,
        now,
      });
      advanced += 1;
      if (state === 'COMPLETE') completed += 1;
    } catch {
      // A database failure (a digest write, the headroom read, the progress write): hold where this sweep
      // durably got to. Best-effort -- if even that write fails, the persisted cursor stands.
      await hold(item, cursor, 'TRANSIENT', null, failedDelta).catch(() => undefined);
    }
  }

  return {
    due: due.length,
    pages: counters.pages,
    skipped,
    skippedOld: counters.skippedOld,
    skippedHasDigest: counters.skippedHasDigest,
    invoked: counters.invoked,
    digestsWritten: tally.written,
    digestsUnchanged: tally.unchanged,
    digestsRefused: tally.refused,
    failedItems: counters.failedItems,
    advanced,
    completed,
    held,
    floodWaits,
    heldBy,
  };
}

interface HydratePageOutcome {
  readonly invoked: number;
  readonly failedItemsDelta: number;
  /** The failure class that holds the page, or null when the whole page was handled. */
  readonly hold: string | null;
}

/** Hydrate one page. Throws what a port throws (the caller holds). */
async function hydratePage(
  ports: ChatsHydrationSweepPorts,
  item: DueChatsHydration,
  principal: WorkPrincipal,
  conversations: readonly TelegramConversationWindow[],
  now: Date,
  counters: Counters,
  tally: DigestTally,
): Promise<HydratePageOutcome> {
  let invoked = 0;
  let failedItemsDelta = 0;
  const done = (hold: string | null): HydratePageOutcome => ({ invoked, failedItemsDelta, hold });

  for (const window of conversations) {
    if (window.messages.length === 0) continue;

    // (a) Too old to be worth a digest: no model call.
    const newest = new Date(Math.max(...window.messages.map((m) => m.occurredAt.getTime())));
    const expiresAt = intelligenceDigestExpiresAt({ subjectKind: 'CONVERSATION', lastEvidenceAt: newest, windowEnd: newest, generatedAt: now });
    if (expiresAt.getTime() <= now.getTime() || newest.getTime() < item.historicalWindowFloorAt.getTime()) {
      counters.skippedOld += 1;
      continue;
    }

    // (b) Already has a current digest: the forward path owns it. No model call.
    const subjectRef = telegramConversationSubjectRef(window.conversationKey);
    if (await ports.hasCurrentConversationDigest(principal, subjectRef, now)) {
      counters.skippedHasDigest += 1;
      continue;
    }

    // Budget reserve: leave forward triage its headroom. Hold; the next sweep (or the next day) resumes.
    if ((await ports.triageHeadroom(item.organizationId, now)) <= ports.budgetReserve) return done(HYDRATION_BUDGET_RESERVE);

    // (c) ONE governed triage call. Only its conversation reading is kept.
    const truncated = window.truncation.reason !== 'NONE';
    const result = await ports.triage(principal, {
      conversationKey: window.conversationKey,
      messages: window.messages,
      truncated,
      evaluatedFloorProviderEventId: window.truncation.oldestIncludedProviderEventId ?? '',
      conversation: window.conversation,
    });
    invoked += 1;
    counters.invoked += 1;

    if (result.outcome === 'NOT_AVAILABLE') return done(refusalFailureClass(result.refusals));
    if (result.outcome === 'FAILED') return done('TRANSIENT');
    if (result.outcome === 'REJECTED_OUTPUT' || result.outcome === 'REFUSED_BY_MODEL') {
      failedItemsDelta += 1; // permanent for this content: advance past it, counted
      continue;
    }

    // TRIAGED. result.items (obligations) are deliberately NOT written, and nothing is reconciled.
    const last: { write: ConversationIntelligenceWrite | null } = { write: null };
    const ended = await recordConversationReading(
      async (p, d) => {
        last.write = await ports.recordConversationIntelligence(p, d);
        return last.write;
      },
      principal,
      window,
      result,
      truncated,
      now,
      tally,
    );
    if (ended) return done(ended); // consent or membership ended: no further body is read
    if (last.write?.outcome === 'NOT_MIGRATED') return done('NOT_MIGRATED'); // nothing to hydrate into yet
  }
  return done(null);
}
