// How current a work source is, and whether a visit should spend a provider call. PURE.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §22.4 (DL-4, GM-1).
//
// ONE POLICY SHAPE, ONE PER SOURCE. DL-4 established this for Calendar and Gmail needs exactly
// the same eight states -- because the question is the same question: can Loop stand behind
// what it is showing, and if not, which kind of not. What differs is only the numbers, and they
// differ because mail moves faster than a calendar does.
//
// "NOTHING HERE" IS ONLY SAYABLE IN `CURRENT` AND `STALE`. Every other state means Loop does not
// know, and the surface must say which one -- never an empty inbox, and never an empty day.

/** Whether Loop can stand behind what it is showing, for any employee work source. */
export const WORK_SOURCE_FRESHNESS = [
  'CURRENT',
  'STALE',
  'NEVER_SYNCED',
  'SYNC_FAILED',
  'NOT_CONNECTED',
  'CAPABILITY_NOT_GRANTED',
  'AUTHORIZATION_EXPIRED',
  'NOT_CONFIGURED',
] as const;
export type WorkSourceFreshness = (typeof WORK_SOURCE_FRESHNESS)[number];

/** The states in which "nothing" means nothing, rather than "I could not look". */
export const WORK_FRESHNESS_ADMITS_EMPTY: readonly WorkSourceFreshness[] = Object.freeze(['CURRENT', 'STALE']);

export interface WorkFreshnessPolicy {
  /** A successful read older than this is shown as stale, with its age. */
  readonly staleAfterMs: number;
  /** Loop refreshes on a visit at most this often. A page render is not a reason to call Google. */
  readonly refreshAfterMs: number;
  /** A person asking by hand is honoured no more often than this. */
  readonly manualFloorMs: number;
}

/**
 * Calendar (DL-4, unchanged): a day's shape changes when somebody moves a meeting, which is
 * minutes-scale, not seconds-scale.
 */
export const CALENDAR_FRESHNESS_POLICY: WorkFreshnessPolicy = Object.freeze({
  staleAfterMs: 2 * 60 * 60 * 1000,
  refreshAfterMs: 15 * 60 * 1000,
  manualFloorMs: 60 * 1000,
});

/**
 * Gmail (GM-1): faster on every axis, deliberately.
 *
 *   staleAfterMs 30 min   A mailbox is stale sooner than a calendar: the reply that arrived
 *                         twenty minutes ago is the reason somebody opened Loop.
 *   refreshAfterMs 5 min  An incremental pass is one `history.list` that usually answers
 *                         "nothing changed", so a visit can afford it far more often than a
 *                         calendar's full window read. This is what makes Loop feel live for
 *                         somebody actually working in it; the background cycle is for the
 *                         hours they are not.
 *   manualFloorMs 30 s    A person who just sent something and wants it reflected should not
 *                         wait a minute -- but two clicks in a second cannot make a mailbox
 *                         newer than one.
 */
export const GMAIL_FRESHNESS_POLICY: WorkFreshnessPolicy = Object.freeze({
  staleAfterMs: 30 * 60 * 1000,
  refreshAfterMs: 5 * 60 * 1000,
  manualFloorMs: 30 * 1000,
});

export interface WorkSourceStateInput {
  /** From the Google connection: is this source connected, and is the grant still good. */
  readonly configured: boolean;
  readonly capability: 'CONNECTED' | 'NOT_CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED';
  /** From the DL-1 cursor and sync runs. */
  readonly lastSyncCompletedAt: Date | null;
  readonly lastRunOutcome: 'SUCCEEDED' | 'TRUNCATED' | 'FAILED' | null;
  /** A run that started and has not finished: the surface may say so rather than guess. */
  readonly syncInProgress?: boolean;
}

/** Which of the eight states a source is in. Connection first: it outranks any stored read. */
export function workSourceFreshness(input: WorkSourceStateInput, now: Date, policy: WorkFreshnessPolicy): WorkSourceFreshness {
  if (!input.configured) return 'NOT_CONFIGURED';
  if (input.capability === 'EXPIRED') return 'AUTHORIZATION_EXPIRED';
  if (input.capability === 'INSUFFICIENT_SCOPE') return 'CAPABILITY_NOT_GRANTED';
  if (input.capability === 'NOT_CONNECTED') return 'NOT_CONNECTED';
  if (!input.lastSyncCompletedAt) return 'NEVER_SYNCED';
  if (input.lastRunOutcome === 'FAILED') return 'SYNC_FAILED';
  return now.getTime() - input.lastSyncCompletedAt.getTime() > policy.staleAfterMs ? 'STALE' : 'CURRENT';
}

/** Whether a visit should spend a provider call, given when the last successful read finished. */
export function shouldRefreshWorkSourceOnVisit(
  freshness: WorkSourceFreshness,
  lastSyncCompletedAt: Date | null,
  now: Date,
  policy: WorkFreshnessPolicy,
): boolean {
  if (freshness === 'NOT_CONNECTED' || freshness === 'NOT_CONFIGURED' || freshness === 'CAPABILITY_NOT_GRANTED' || freshness === 'AUTHORIZATION_EXPIRED') {
    return false;
  }
  if (!lastSyncCompletedAt) return true;
  return now.getTime() - lastSyncCompletedAt.getTime() >= policy.refreshAfterMs;
}

/** Whether a by-hand refresh is honoured, given when the last attempt STARTED. */
export function shouldHonourManualRefresh(lastSyncStartedAt: Date | null, now: Date, policy: WorkFreshnessPolicy): boolean {
  if (!lastSyncStartedAt) return true;
  return now.getTime() - lastSyncStartedAt.getTime() >= policy.manualFloorMs;
}
