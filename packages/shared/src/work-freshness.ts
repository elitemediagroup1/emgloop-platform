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
  // A first read that FAILED is a failure, not "not read yet": the person is owed the difference
  // between "Loop is still setting this up" and "Loop tried and could not".
  if (!input.lastSyncCompletedAt) return input.lastRunOutcome === 'FAILED' ? 'SYNC_FAILED' : 'NEVER_SYNCED';
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

// --- Readiness: what a person is told about a source they connected -----------------------------
//
// CONNECTED IS NOT READY. OAuth succeeding means Loop MAY read a source; it says nothing about
// whether Loop HAS. A person who connects Gmail and sees "Connected" reasonably concludes Loop is
// using their mail -- and when nothing appears, concludes Loop is broken. Readiness is derived
// from the connection AND what Loop has actually read, and it is what every surface that talks
// about a connected source says.

/**
 * How long an unfinished sync run is believed to still be running.
 *
 * A run with no finish time is either in flight or dead -- a request the platform cut off, which
 * never gets to record its end. After this long it is taken to be dead and says nothing about
 * what is happening now, so a person is never told "Loop is reading" forever. The same five
 * minutes the scheduled cycle waits before it will start another pass for the same person.
 */
export const WORK_SYNC_IN_FLIGHT_MS = 5 * 60_000;

/** Whether this run is plausibly still going. */
export function syncRunInFlight(run: { readonly startedAt: Date; readonly finishedAt: Date | null } | null | undefined, now: Date): boolean {
  return !!run && run.finishedAt === null && now.getTime() - run.startedAt.getTime() < WORK_SYNC_IN_FLIGHT_MS;
}

/**
 * Where a connected source stands, for the person who connected it.
 *
 *   NOT_CONFIGURED       this deployment cannot connect Google at all.
 *   NOT_CONNECTED        no grant for this source.
 *   PERMISSION_NEEDED    a grant exists, but Google did not give everything this source needs (a
 *                        box left unticked on Google's screen). The person allows it again.
 *   RECONNECT_REQUIRED   Google no longer accepts the grant (expired or withdrawn).
 *   INITIALIZING         connected, and Loop has not yet completed a first read.
 *   READING              connected, read before, and a read is under way right now.
 *   READY                connected, and Loop has read it. Only this state means "Loop is using it".
 *   SYNC_FAILED          the most recent read failed.
 */
export const SOURCE_READINESS = [
  'NOT_CONFIGURED',
  'NOT_CONNECTED',
  'PERMISSION_NEEDED',
  'RECONNECT_REQUIRED',
  'INITIALIZING',
  'READING',
  'READY',
  'SYNC_FAILED',
] as const;
export type SourceReadiness = (typeof SOURCE_READINESS)[number];

export function sourceReadiness(input: {
  readonly freshness: WorkSourceFreshness;
  /** A run started within WORK_SYNC_IN_FLIGHT_MS and not finished (see `syncRunInFlight`). */
  readonly inFlight: boolean;
  /** Whether any read of this source has ever completed. */
  readonly everRead: boolean;
}): SourceReadiness {
  switch (input.freshness) {
    case 'NOT_CONFIGURED':
      return 'NOT_CONFIGURED';
    case 'NOT_CONNECTED':
      return 'NOT_CONNECTED';
    case 'CAPABILITY_NOT_GRANTED':
      return 'PERMISSION_NEEDED';
    case 'AUTHORIZATION_EXPIRED':
      return 'RECONNECT_REQUIRED';
    case 'NEVER_SYNCED':
      return 'INITIALIZING';
    case 'SYNC_FAILED':
      // A retry under way is a read in progress, not a failure yet -- but a first read that is
      // retrying is still setting up, never "reading again".
      return input.inFlight ? (input.everRead ? 'READING' : 'INITIALIZING') : 'SYNC_FAILED';
    case 'CURRENT':
    case 'STALE':
      return input.inFlight ? 'READING' : 'READY';
  }
}
