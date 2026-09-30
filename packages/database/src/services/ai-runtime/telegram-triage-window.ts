// Has Loop already judged this exact Telegram window? (2026-09-30.)
//
// The forward content sweep re-reads a conversation whenever the authorization's content cursor is held, and
// production showed what that cost: the SAME windows sent to Anthropic cycle after cycle -- 69 calls in a day,
// the triage class cap -- while one timing-out conversation held everyone else back. This answers, from what
// Loop already records and nothing new, whether a window needs a model call:
//
//   the ledger     every call's content-free `contextManifestHash` (the window's keyed message refs, hashed the
//                  way the gateway hashes them), outcome and time, per person, task and template version;
//   the digest     the person's CHATS reading carries the window's fingerprint (conversation key, message ids,
//                  schema) once the obligations AND the reading were written.
//
// THE POLICY (TELEGRAM_TRIAGE_WINDOW_POLICY):
//   HANDLED      the window's reading is stored; or it was REJECTED, or refused by the model, within the
//                handling period; or it was ANSWERED twice there (an answer whose writes failed is asked
//                again ONCE, never forever). No call.
//   EXHAUSTED    it FAILED `maxFailedAttempts` times within the handling period: Loop stops paying for this
//                exact window, records it as abandoned, and lets the cursor move. The conversation is NOT
//                dropped: its next message makes a new window, judged afresh.
//   BACKED_OFF   its latest failure is younger than `failureBackoffMs`: no call now, retried after.
//   NEW          otherwise: one call.
// A new message changes the manifest, so a new window is always NEW. A new template or task version is a new
// question. Nothing here reads or keeps message text.

import type { PrismaClient } from '@prisma/client';
import { AI_TASK_TELEGRAM_CONTENT_TRIAGE } from '@emgloop/shared';

import { aiContextManifestHash, AiUsageLedgerRepository } from '../../repositories/ai-usage-ledger.repository';
import { IntelligenceDigestRepository } from '../../repositories/intelligence/intelligence-digest.repository';
import { telegramTriageManifestRefs, type TelegramTriageContextInput } from './telegram-content-triage-context';
import { TELEGRAM_CONTENT_TRIAGE_TEMPLATE_ID, TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION } from './templates/telegram-content-triage';

const HOUR = 60 * 60 * 1000;

/**
 * The retry conventions Loop already uses: the domain kit's 3-hour failure backoff (MODEL_FAILURE_BACKOFF_MS)
 * and the refresh queue's 4 attempts before it holds a request.
 */
export const TELEGRAM_TRIAGE_WINDOW_POLICY = Object.freeze({
  handledForMs: 7 * 24 * HOUR,
  failureBackoffMs: 3 * HOUR,
  maxFailedAttempts: 4,
});

export type TelegramTriageWindowVerdict = 'NEW' | 'HANDLED' | 'BACKED_OFF' | 'EXHAUSTED';

export interface TelegramTriageWindowHistory {
  readonly answered: number;
  readonly rejected: number;
  readonly refusedByModel: number;
  readonly failed: number;
  readonly lastFailedAt: Date | null;
  /** The person's CHATS reading carries this window's fingerprint: every write for it completed. */
  readonly readingStored: boolean;
}

/** The decision, pure. */
export function decideTriageWindow(h: TelegramTriageWindowHistory, now: Date, policy = TELEGRAM_TRIAGE_WINDOW_POLICY): TelegramTriageWindowVerdict {
  if (h.readingStored || h.rejected > 0 || h.refusedByModel > 0 || h.answered >= 2) return 'HANDLED';
  if (h.failed >= policy.maxFailedAttempts) return 'EXHAUSTED';
  if (h.lastFailedAt && now.getTime() - h.lastFailedAt.getTime() < policy.failureBackoffMs) return 'BACKED_OFF';
  return 'NEW';
}

/** The window's content-free identity: the gateway's `contextManifestHash` for it, computed before the call. */
export function telegramTriageWindowManifestHash(input: TelegramTriageContextInput): string {
  return aiContextManifestHash(telegramTriageManifestRefs(input));
}

export class TelegramTriageWindowJudge {
  constructor(private readonly prisma: PrismaClient) {}

  async judge(
    principal: { readonly organizationId: string; readonly userId: string },
    window: { readonly manifestHash: string; readonly subjectRef: string; readonly digestFingerprint: string },
    now: Date,
  ): Promise<TelegramTriageWindowVerdict> {
    const [outcomes, stored] = await Promise.all([
      new AiUsageLedgerRepository(this.prisma).windowOutcomes(principal.organizationId, {
        principalUserId: principal.userId,
        taskId: AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId,
        taskVersion: AI_TASK_TELEGRAM_CONTENT_TRIAGE.version,
        templateId: TELEGRAM_CONTENT_TRIAGE_TEMPLATE_ID,
        templateVersion: TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION,
        contextManifestHash: window.manifestHash,
        since: new Date(now.getTime() - TELEGRAM_TRIAGE_WINDOW_POLICY.handledForMs),
      }),
      new IntelligenceDigestRepository(this.prisma).storedFingerprint(
        { scope: 'PRINCIPAL', principal: { organizationId: principal.organizationId, userId: principal.userId } },
        { domain: 'CHATS', subjectKind: 'CONVERSATION', subjectRef: window.subjectRef },
      ),
    ]);
    return decideTriageWindow({ ...outcomes, readingStored: stored?.fingerprint === window.digestFingerprint && stored.status !== 'WITHDRAWN' }, now);
  }
}
