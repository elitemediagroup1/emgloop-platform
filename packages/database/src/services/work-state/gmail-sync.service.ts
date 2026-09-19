// One employee's Gmail, synchronized into their own private work state (GM-1).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6, §8.2, §13 and §17.
//
// IT PERSISTS METADATA AND NOTHING ELSE. The sensor's sync read asks Gmail for headers, labels
// and timestamps -- never a body -- so the rows this writes cannot contain correspondence even
// by accident. A body is read when an employee opens a thread, rendered, and discarded; the
// retention record already calls that GOOGLE_RAW_RESPONSES / NEVER_STORED.
//
// WHOSE MAILBOX. Every method takes a `WorkPrincipal`, the connection is read for THAT
// principal, and the rows are written for THAT principal. There is no path here that takes an
// organization and a user from different places, and no role widens it.
//
// A FAILED READ IS NEVER AN EMPTY INBOX. Every refusal keeps its class, is recorded on the run
// and on the cursor, and leaves stored messages exactly as they were.
//
// IDEMPOTENT BY PROVIDER KEY. Every write is an upsert on (organization, user, provider,
// messageId), so a re-read changes nothing the second time. The one additive fact -- a
// correspondent's inbound/outbound tally -- is counted ONLY for a message this pass had not
// seen before, which is why each thread's stored messages are read once before writing.
//
// GOOGLE, THE CLOCK AND THE SENSOR ARE INJECTED. No credential, no request, no Google field.

import {
  gmailFailureForConnectionState,
  normalizeGmailAddress,
  workSyncFailureForGmailFailure,
  type GmailAddress,
  type GmailMessageFact,
  type GmailReadFailure,
  type GmailReadResult,
  type WorkDirection,
} from '@emgloop/shared';

import type { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import type { WorkSourceRepository } from '../../repositories/work-state/work-source.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';
import type { CalendarConnectionState } from './calendar-sync.service';

/** The first read's window. Daily Loop reasons about the current work period, not a lifetime. */
export const GMAIL_INITIAL_DAYS = 14;

/**
 * The most a FRESHNESS pass reads: a page visit or a person pressing Refresh.
 *
 * A request someone is waiting on must never carry a mailbox's worth of Gmail calls. Every message
 * is one sequential request, so the ceiling is a latency budget: twenty-five is a few seconds, and
 * the incremental read resumes where it stopped, so the next pass (or the scheduled cycle, which
 * reads up to the full pass ceiling) carries on from there.
 */
export const GMAIL_FRESHNESS_MAX_MESSAGES = 25;
export const GMAIL_FRESHNESS_MAX_PAGES = 2;

/** An access token for one principal's OWN connection, or why there is none. */
export interface GmailAccessPort {
  accessToken(principal: WorkPrincipal): Promise<{ readonly ok: true; readonly accessToken: string } | { readonly ok: false; readonly state: CalendarConnectionState }>;
  /** The connected account's own address, so "did I send this" is a fact rather than a guess. */
  identity(principal: WorkPrincipal): Promise<{ readonly selfAddress: string | null; readonly internalDomains: readonly string[] }>;
}

/** The GM-1 sensor, as this service needs it. The runtime binds the real adapter. */
export interface GmailSensorPort {
  readWindow(request: {
    readonly accessToken: string;
    readonly selfAddress: string | null;
    readonly newerThanDays: number;
  }): Promise<GmailReadResult>;
  readChanges(request: {
    readonly accessToken: string;
    readonly selfAddress: string | null;
    readonly startHistoryId: string;
    /** Tighter ceilings for a pass somebody is waiting on. Absent: the sensor's own. */
    readonly maxMessages?: number;
    readonly maxPages?: number;
  }): Promise<GmailReadResult>;
}

export interface GmailSyncDeps {
  readonly sources: WorkSourceRepository;
  readonly graph: WorkGraphRepository;
  readonly access: GmailAccessPort;
  readonly sensor: GmailSensorPort;
  /** SHA-256 of a normalized address. Injected so this file holds no crypto and no Google. */
  readonly addressHash: (address: string) => string;
  readonly now?: () => Date;
  readonly initialDays?: number;
}

/**
 * How a pass read.
 *
 *   WINDOW        the bounded first read, because there was no cursor.
 *   INCREMENTAL   Gmail's history since the stored cursor.
 *   REBASELINE    a bounded window read although a cursor existed -- because Gmail no longer
 *                 keeps that history position (404), or because the caller asked for one.
 */
export type GmailSyncMode = 'WINDOW' | 'INCREMENTAL' | 'REBASELINE';

export interface GmailSyncOptions {
  /**
   * Read the rolling window again instead of the stored history position.
   *
   * Gmail keeps history for "at least one week, often longer" (its own sync guide), so a
   * cursor that has not been used for longer than that is gone -- and a mailbox that has been
   * quiet is exactly the one nobody noticed. A periodic baseline re-establishes a position
   * before it can expire, and repairs anything a truncated pass left behind.
   */
  readonly baseline?: boolean;
  /**
   * How far this pass may go.
   *
   *   FULL       the scheduled cycle. Performs the first 14-day read when there is no position,
   *              re-reads the window when Gmail no longer keeps the position, and reads up to the
   *              sensor's full ceiling. The ONLY reach that performs a baseline.
   *   FRESHNESS  a page visit or a person pressing Refresh. Reads only what changed since the
   *              stored position, within GMAIL_FRESHNESS_MAX_MESSAGES. With no position yet it
   *              does nothing at all -- no run, no Google call -- and answers DEFERRED: the first
   *              read belongs to the cycle, never to a request somebody is waiting on.
   *
   * Absent: FULL, so the cycle's behaviour is what a caller gets unless it asks for less.
   */
  readonly reach?: 'FULL' | 'FRESHNESS';
}

export interface GmailSyncOutcome {
  /** DEFERRED: a FRESHNESS pass found no position to read from, so it read nothing and wrote nothing. */
  readonly outcome: 'SUCCEEDED' | 'TRUNCATED' | 'FAILED' | 'DEFERRED';
  readonly mode: GmailSyncMode;
  readonly examined: number;
  readonly written: number;
  /** Messages Gmail reported as gone, and Loop therefore forgot. */
  readonly removed: number;
  readonly failure: GmailReadFailure | null;
  readonly cursorAdvanced: boolean;
}

const directionOf = (fact: GmailMessageFact): WorkDirection => (fact.fromSelf ? 'OUTBOUND' : 'INBOUND');

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

export class GmailSyncService {
  constructor(private readonly deps: GmailSyncDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Synchronize ONE employee's mailbox into their own work state. Nobody else's. */
  async syncGmail(principal: WorkPrincipal, options: GmailSyncOptions = {}): Promise<GmailSyncOutcome> {
    const freshnessOnly = options.reach === 'FRESHNESS';
    const cursor = await this.deps.sources.cursor(principal, 'GMAIL');
    const storedHistoryId = cursor?.cursorKind === 'GMAIL_HISTORY_ID' ? cursor.cursor : null;
    if (freshnessOnly && !storedHistoryId) {
      // No position yet: the first read has not happened (or has to happen again). That is the
      // cycle's job. Nothing is started, nothing is written, and Google is not called.
      return { outcome: 'DEFERRED', mode: 'WINDOW', examined: 0, written: 0, removed: 0, failure: null, cursorAdvanced: false };
    }

    const startedAt = this.now();
    const run = await this.deps.sources.startRun(principal, 'GMAIL', startedAt);

    const token = await this.deps.access.accessToken(principal);
    if (!token.ok) return this.fail(principal, run.id, 'WINDOW', gmailFailureForConnectionState(token.state));

    const identity = await this.deps.access.identity(principal);
    // A requested baseline sets the stored position aside for this pass. It is not deleted: the
    // cursor is only ever replaced by a read that succeeded.
    const useHistory = options.baseline && !freshnessOnly ? null : storedHistoryId;
    const newerThanDays = this.deps.initialDays ?? GMAIL_INITIAL_DAYS;
    const bounds = freshnessOnly ? { maxMessages: GMAIL_FRESHNESS_MAX_MESSAGES, maxPages: GMAIL_FRESHNESS_MAX_PAGES } : {};

    let mode: GmailSyncMode = useHistory ? 'INCREMENTAL' : storedHistoryId ? 'REBASELINE' : 'WINDOW';
    let result: GmailReadResult = useHistory
      ? await this.deps.sensor.readChanges({ accessToken: token.accessToken, selfAddress: identity.selfAddress, startHistoryId: useHistory, ...bounds })
      : await this.deps.sensor.readWindow({ accessToken: token.accessToken, selfAddress: identity.selfAddress, newerThanDays });

    if (!result.ok && result.failure === 'CURSOR_EXPIRED' && !freshnessOnly) {
      // Gmail no longer keeps that history position. Its own guide's answer is one full read;
      // Loop's is one BOUNDED full read, which is the same thing without the mailbox crawl.
      mode = 'REBASELINE';
      result = await this.deps.sensor.readWindow({ accessToken: token.accessToken, selfAddress: identity.selfAddress, newerThanDays });
    }

    if (!result.ok) return this.fail(principal, run.id, mode, result.failure);

    const observedAt = this.now();
    const { written } = await this.persist(principal, result.page.messages, identity.selfAddress, observedAt);
    const { removed } = await this.forget(principal, result.page.removedMessageIds);

    const finishedAt = this.now();
    const truncated = result.page.truncated;
    // The sensor returns a position ONLY when it skips nothing newer than itself: a capped window
    // leaves out its oldest messages, and a capped incremental pass hands back the last history
    // record it consumed whole (GmailMessagePage). So whenever there is one, it is stored -- which
    // is what lets a busy mailbox reach incremental reads, and a bounded pass make progress.
    const advance = result.page.nextHistoryId !== null;
    if (advance) {
      await this.deps.sources.advanceCursor(principal, 'GMAIL', {
        cursor: result.page.nextHistoryId,
        cursorKind: 'GMAIL_HISTORY_ID',
        startedAt,
        completedAt: finishedAt,
        failureClass: null,
      });
    } else {
      await this.deps.sources.advanceCursor(principal, 'GMAIL', { startedAt, completedAt: finishedAt, failureClass: null });
    }

    await this.deps.sources.finishRun(principal, run.id, {
      finishedAt,
      outcome: truncated ? 'TRUNCATED' : 'SUCCEEDED',
      examined: result.page.messages.length,
      written,
    });

    return {
      outcome: truncated ? 'TRUNCATED' : 'SUCCEEDED',
      mode,
      examined: result.page.messages.length,
      written,
      removed,
      failure: null,
      cursorAdvanced: advance,
    };
  }

  /**
   * Write the facts, thread by thread.
   *
   * Each thread's stored messages are read ONCE before anything is written, for two reasons:
   * a correspondent's tally may only count a message that is new, and the thread's aggregate
   * (its span, its newest message, who is on it) is recomputed from every message Loop holds
   * rather than from the handful this pass happened to see.
   */
  private async persist(
    principal: WorkPrincipal,
    facts: readonly GmailMessageFact[],
    selfAddress: string | null,
    observedAt: Date,
  ): Promise<{ readonly written: number }> {
    const byThread = new Map<string, GmailMessageFact[]>();
    for (const fact of facts) {
      const list = byThread.get(fact.threadId);
      if (list) list.push(fact);
      else byThread.set(fact.threadId, [fact]);
    }

    const self = selfAddress ? normalizeGmailAddress(selfAddress) : null;
    let written = 0;

    for (const [threadId, threadFacts] of byThread) {
      const stored = await this.deps.graph.messages(principal, threadId, 500);
      const known = new Set(stored.map((row) => row.messageId));

      for (const fact of threadFacts) {
        const direction = directionOf(fact);
        const isNew = !known.has(fact.messageId);
        await this.deps.graph.upsertMessage(principal, {
          provider: 'GOOGLE',
          messageId: fact.messageId,
          threadId: fact.threadId,
          internalDate: fact.internalDate,
          direction,
          fromHash: fact.from ? this.deps.addressHash(fact.from.address) : null,
          toHashes: fact.to.map((a) => this.deps.addressHash(a.address)),
          ccHashes: fact.cc.map((a) => this.deps.addressHash(a.address)),
          subject: fact.subject,
          headerMessageId: fact.headerMessageId,
          inReplyTo: fact.inReplyTo,
          references: fact.references,
          labels: fact.labels,
          observedAt,
        });
        written += 1;
        if (isNew) {
          known.add(fact.messageId);
          await this.recordCorrespondents(principal, fact, direction, self, observedAt);
        }
      }

      await this.recomputeThread(principal, threadId, threadFacts);
    }
    return { written };
  }

  /**
   * Everybody on one message, except the employee themselves.
   *
   * A correspondent is somebody an employee corresponds WITH. Counting their own address would
   * make them their own most frequent contact, and the direction is the message's, not the
   * address's: a person on an inbound message was corresponded with inbound.
   */
  private async recordCorrespondents(
    principal: WorkPrincipal,
    fact: GmailMessageFact,
    direction: WorkDirection,
    self: string | null,
    observedAt: Date,
  ): Promise<void> {
    const everyone: GmailAddress[] = [...(fact.from ? [fact.from] : []), ...fact.to, ...fact.cc];
    const seen = new Set<string>();
    for (const address of everyone) {
      const normalized = normalizeGmailAddress(address.address);
      if (normalized === '' || normalized === self || seen.has(normalized)) continue;
      seen.add(normalized);
      await this.deps.graph.recordCorrespondent(principal, {
        addressHash: this.deps.addressHash(normalized),
        displayAddress: normalized,
        displayName: address.name,
        domain: domainOf(normalized),
        seenAt: fact.internalDate > observedAt ? observedAt : fact.internalDate,
        direction,
      });
    }
  }

  /** The thread as Loop now holds it: counted, spanned and attributed from its own rows. */
  private async recomputeThread(principal: WorkPrincipal, threadId: string, seen: readonly GmailMessageFact[]): Promise<void> {
    const rows = await this.deps.graph.messages(principal, threadId, 500);
    if (rows.length === 0) {
      await this.deps.graph.forgetThread(principal, 'GOOGLE', threadId);
      return;
    }
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const participants = new Set<string>();
    for (const row of rows) {
      if (row.fromHash) participants.add(row.fromHash);
      for (const hash of row.toHashes) participants.add(hash);
      for (const hash of row.ccHashes) participants.add(hash);
    }
    // The subject of the conversation is its first message's; a reply's "Re:" is not a new
    // subject. The labels are the NEWEST message's, which is what "unread" means to a reader.
    const newestSeen = [...seen].sort((a, b) => b.internalDate.getTime() - a.internalDate.getTime())[0];
    await this.deps.graph.upsertThread(principal, {
      provider: 'GOOGLE',
      threadId,
      subject: first.subject,
      participantHashes: [...participants],
      messageCount: rows.length,
      firstMessageAt: first.internalDate,
      lastMessageAt: last.internalDate,
      lastDirection: last.direction as WorkDirection,
      lastMessageId: last.messageId,
      labels: newestSeen && newestSeen.messageId === last.messageId ? newestSeen.labels : last.labels,
    });
  }

  /** What Gmail says is gone, goes -- and the thread it was on is recounted without it. */
  private async forget(principal: WorkPrincipal, messageIds: readonly string[]): Promise<{ readonly removed: number }> {
    let removed = 0;
    const threads = new Set<string>();
    for (const messageId of messageIds) {
      const row = await this.deps.graph.messageByProviderId(principal, 'GOOGLE', messageId);
      if (!row) continue;
      threads.add(row.threadId);
      if (await this.deps.graph.forgetMessage(principal, 'GOOGLE', messageId)) removed += 1;
    }
    for (const threadId of threads) await this.recomputeThread(principal, threadId, []);
    return { removed };
  }

  /** Record a failed pass, on the run and on the cursor, and change nothing that was stored. */
  private async fail(principal: WorkPrincipal, runId: string, mode: GmailSyncMode, failure: GmailReadFailure): Promise<GmailSyncOutcome> {
    const finishedAt = this.now();
    const failureClass = workSyncFailureForGmailFailure(failure);
    await this.deps.sources.advanceCursor(principal, 'GMAIL', { failureClass });
    await this.deps.sources.finishRun(principal, runId, { finishedAt, outcome: 'FAILED', failureClass });
    return { outcome: 'FAILED', mode, examined: 0, written: 0, removed: 0, failure, cursorAdvanced: false };
  }
}
