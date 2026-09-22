// The worker's CONTENT sweep: read NEW inbound message bodies TRANSIENTLY, judge each through the
// governed AI runtime, and raise a minimized, employee-private WorkItem only when the verdict is
// actionable. COMPLETELY INDEPENDENT of the live observation sweep and the baseline sweep: this
// orchestrator has NO port that can write the live observation cursor (SourceConnection.cursor) or the
// baseline checkpoint. It advances ONLY the content cursor. That independence is structural, not a
// promise -- there is no method here that could move the other two.
//
// THREE THINGS MUST HOLD BEFORE ANY BODY IS READ FOR AN EMPLOYEE:
//   1. content authorization (dueForContent returns only authorized, not-revoked rows);
//   2. a live, openable credential (openCredential returns non-null);
//   and then, for each message, the governed gateway re-checks a THIRD thing itself:
//   3. activation, budget, this person's authority, routing and the output contract.
// A revoke removes (1); a disconnect removes (2); a deployment with AI off makes (3) refuse. Any of
// them yields NO WorkItem. The gateway's refusal (REFUSED_BY_LOOP) HOLDS the content cursor, so the
// same messages are judged again once the deployment is configured -- nothing is silently skipped.
//
// THE BODY IS TRANSIENT. It is fetched, judged, and dropped. It is never persisted, never logged, and
// never carried into the WorkItem or its evidence -- the evidence keeps only keyed identifiers, the
// invocation id, the task version and the category. The one-line title is the model's MINIMIZED
// paraphrase, never the message.

import type { AdapterSession, DueContent, WorkItemDetection, WorkPrincipal } from '@emgloop/database';
import { AI_TASK_TELEGRAM_CONTENT_TRIAGE, type ConnectionProvider } from '@emgloop/shared';

import { telegramContentRefs, type TelegramContentMessage } from './telegram/telegram-content';
import type { TelegramTriageInput, TelegramTriageResult } from '@emgloop/database';

/** What one content page produced. Content-bearing but TRANSIENT: bodies are dropped after triage. */
export interface ContentObservationResult {
  readonly messages: readonly TelegramContentMessage[];
  /** The next content cursor. NEVER the live observation cursor and NEVER the baseline checkpoint. */
  readonly nextCursor: string | null;
  /** Present when the provider asked Loop to wait: the cursor holds and the sweep backs off. */
  readonly floodWaitSeconds?: number;
}

/** The adapter capability the content sweep needs. TelegramAdapter satisfies this structurally. */
export interface ContentAdapter {
  readonly provider: ConnectionProvider;
  resume(secret: string, binding: { organizationId: string; userId: string }): Promise<AdapterSession>;
  observeContent(session: AdapterSession, cursor: string | null, limit: number, now: Date): Promise<ContentObservationResult>;
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
  /** Judge ONE message through the governed AI runtime. The body reaches nothing but this call. */
  triage(principal: WorkPrincipal, input: TelegramTriageInput): Promise<TelegramTriageResult>;
  /** Persist ONE minimized, employee-private WorkItem (WorkItemRepository.detect). No body, ever. */
  raiseWorkItem(principal: WorkPrincipal, detection: WorkItemDetection): Promise<void>;
  /** Advance (or hold) the content cursor. MUST NOT touch source_connections or the baseline. */
  recordContentProgress(due: DueContent, progress: ContentProgressToRecord): Promise<void>;
  /** How many new messages one run reads per authorization (bounded). */
  readonly contentPageSize: number;
  now(): Date;
}

export interface ContentSweepSummary {
  readonly due: number;
  readonly swept: number;
  readonly skipped: number;
  readonly held: number;
  readonly raised: number;
  readonly refused: number;
  readonly floodWaits: number;
}

/** The producer identity for a content-triage WorkItem. MODEL, so it is the same row a rule would write. */
const PRODUCER_ID = AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId;

/** Run one content sweep over all due authorizations. Never throws for a single authorization. */
export async function runContentSweep(ports: ContentSweepPorts): Promise<ContentSweepSummary> {
  const due = await ports.dueForContent();
  const now = ports.now();
  let swept = 0;
  let skipped = 0;
  let held = 0;
  let raised = 0;
  let refused = 0;
  let floodWaits = 0;

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

      let page: ContentObservationResult;
      try {
        page = await adapter.observeContent(session, item.contentCursor, ports.contentPageSize, now);
      } catch {
        await ports.recordContentProgress(item, hold(item.contentCursor, 'TRANSIENT', null, now));
        held += 1;
        await adapter.disconnect(session).catch(() => undefined);
        continue;
      }
      await adapter.disconnect(session).catch(() => undefined);

      if (page.floodWaitSeconds !== undefined) {
        const backoffUntil = new Date(now.getTime() + Math.max(0, page.floodWaitSeconds) * 1000);
        await ports.recordContentProgress(item, hold(item.contentCursor, 'FLOOD_WAIT', backoffUntil, now));
        held += 1;
        floodWaits += 1;
        continue;
      }

      const outcome = await processMessages(ports, item, page.messages, now);
      raised += outcome.raised;
      if (outcome.refused) refused += 1;
      await ports.recordContentProgress(item, {
        contentCursor: outcome.cursor,
        failureClass: outcome.failureClass,
        backoffUntil: null,
        now,
      });
      swept += 1;
    } catch {
      // A single authorization's unexpected error never breaks the sweep.
      held += 1;
    }
  }

  return { due: due.length, swept, skipped, held, raised, refused, floodWaits };
}

/**
 * Judge each NEW inbound message with text, oldest first, advancing the content cursor as each is
 * handled. A governance refusal (REFUSED_BY_LOOP) HOLDS the cursor at the last handled message and
 * stops the run, so nothing is silently skipped while the deployment is misconfigured. A per-message
 * model outcome (a rejection, a model refusal, a transient failure) is recorded as handled and the
 * cursor advances, so one message can never wedge the sweep.
 */
async function processMessages(
  ports: ContentSweepPorts,
  item: DueContent,
  messages: readonly TelegramContentMessage[],
  now: Date,
): Promise<{ cursor: string | null; raised: number; refused: boolean; failureClass: string | null }> {
  const ordered = [...messages].sort((a, b) => Number(a.messageId) - Number(b.messageId));
  let cursor = item.contentCursor;
  let raised = 0;
  const principal: WorkPrincipal = { organizationId: item.organizationId, userId: item.userId };

  for (const message of ordered) {
    // Only NEW inbound messages with text are triaged. An outbound or empty message is "seen" and the
    // cursor advances past it without reading it as content.
    if (message.out || message.text.trim() === '') {
      cursor = advance(cursor, message);
      continue;
    }

    const refs = telegramContentRefs(message, ports.conversationSecret);
    const result = await ports.triage(principal, {
      providerEventId: refs.providerEventId,
      body: message.text,
      occurredAt: new Date(message.dateSeconds * 1000),
    });

    // GATE 3 (the gateway's own): not authorized, not activated, no configured provider, no budget.
    // HOLD the cursor and stop -- these are deployment-level and all-or-nothing; retry next run.
    if (result.outcome === 'NOT_AVAILABLE') {
      // DIAGNOSTIC: keep the SPECIFIC admission refusal(s) so one sweep names the exact gate that
      // refused, instead of collapsing every governed refusal to the opaque 'REFUSED_BY_LOOP'.
      // `AiAdmissionRefusal` is a fixed, safe enum (NOT_AUTHORIZED / ORGANIZATION_NOT_ENABLED /
      // TASK_NOT_ENABLED / KILL_SWITCH / CONTEXT_REFUSED / LEDGER_UNAVAILABLE / ...) -- never a
      // message body, a secret, or provider text.
      const failureClass =
        result.refusals.length > 0 ? `REFUSED_BY_LOOP:${result.refusals.join('+')}` : 'REFUSED_BY_LOOP';
      return { cursor, raised, refused: true, failureClass };
    }

    if (result.outcome === 'TRIAGED' && result.verdict.actionable) {
      // A minimized, employee-private WorkItem. NO BODY: the title is the model's paraphrase, and the
      // evidence carries only keyed identifiers, the invocation id, the task version and the category.
      const detection: WorkItemDetection = {
        // One item per conversation (rule + keyed conversation): a newer actionable message updates it
        // rather than stacking duplicates.
        recurrenceKey: `${PRODUCER_ID}:${refs.conversationKey}`,
        class: 'NEEDS_YOU',
        subjectKind: 'THREAD',
        subjectRef: `telegram_conversation:${refs.conversationKey}`,
        title: result.verdict.oneLineMeaning,
        producerKind: 'MODEL',
        producerId: PRODUCER_ID,
        producerVersion: result.verdict.provenance.taskVersion,
        evidence: {
          provider: 'TELEGRAM',
          providerEventId: refs.providerEventId,
          conversationKey: refs.conversationKey,
          aiInvocationId: result.verdict.provenance.invocationId,
          aiTaskVersion: result.verdict.provenance.taskVersion,
          category: result.verdict.category,
        },
        detectedAt: now,
      };
      await ports.raiseWorkItem(principal, detection);
      raised += 1;
    }

    // TRIAGED (not actionable), REJECTED_OUTPUT, REFUSED_BY_MODEL and FAILED all mean the message was
    // judged (or a model-level outcome recorded); advance so it is not re-judged.
    cursor = advance(cursor, message);
  }

  return { cursor, raised, refused: false, failureClass: null };
}

/** The higher of the current cursor and this message's id, as a string. Monotonic, never backward. */
function advance(cursor: string | null, message: TelegramContentMessage): string {
  const current = cursor ? Number(cursor) : 0;
  const id = Number(message.messageId);
  return String(Number.isFinite(id) && id > current ? id : current);
}

/** A progress record that HOLDS the content cursor where it is (never advances it). */
function hold(cursor: string | null, failureClass: string, backoffUntil: Date | null, now: Date): ContentProgressToRecord {
  return { contentCursor: cursor, failureClass, backoffUntil, now };
}
