// Where one person's Gmail or Calendar stands: connected, and what Loop has actually read. SERVER ONLY.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §22.4 (freshness) and
// @emgloop/shared `sourceReadiness`.
//
// ONE DERIVATION FOR EVERY SURFACE. Connections, Mail and Home all ask the same question -- can
// Loop stand behind this source, and if not, which kind of not -- so they read it from here and
// can never disagree. "Connected" comes from what Google granted; "ready" comes only from a read
// that completed.
//
// WHOSE SOURCE. The principal is the caller's own, from the signed session. Every read below is
// scoped by organization AND person through the DL-1 repositories: there is no argument that
// reports on somebody else's mailbox or calendar.
import 'server-only';
import {
  CALENDAR_FRESHNESS_POLICY,
  GMAIL_FRESHNESS_POLICY,
  sourceReadiness,
  syncRunInFlight,
  workSourceFreshness,
  type SourceReadiness,
  type WorkSourceFreshness,
  type WorkSyncFailureClass,
} from '@emgloop/shared';
import { WorkSourceRepository, prisma, type GoogleWorkspaceStatus, type WorkPrincipal } from '@emgloop/database';

export type ReadSource = 'GMAIL' | 'CALENDAR';

const CAPABILITY = { GMAIL: 'gmail', CALENDAR: 'calendar' } as const;
const POLICY = { GMAIL: GMAIL_FRESHNESS_POLICY, CALENDAR: CALENDAR_FRESHNESS_POLICY } as const;

export interface SourceState {
  readonly source: ReadSource;
  readonly freshness: WorkSourceFreshness;
  readonly readiness: SourceReadiness;
  /** When the most recent read that completed finished. Null: Loop has never finished reading it. */
  readonly lastReadAt: Date | null;
  /** A read started in the last few minutes and not yet finished. */
  readonly inFlight: boolean;
  /** Whether Loop holds a position to read changes from. Without one, only the first read can help. */
  readonly hasPosition: boolean;
  /** Why the most recent read failed, as a class -- never Google's text. */
  readonly failure: WorkSyncFailureClass | null;
}

export async function loadSourceState(
  principal: WorkPrincipal,
  source: ReadSource,
  status: GoogleWorkspaceStatus,
  now: Date = new Date(),
): Promise<SourceState> {
  const sources = new WorkSourceRepository(prisma);
  const [cursor, runs] = await Promise.all([sources.cursor(principal, source), sources.recentRuns(principal, 1, source)]);
  const last = runs[0] ?? null;
  const lastReadAt = cursor?.lastSyncCompletedAt ?? null;
  const freshness = workSourceFreshness(
    {
      configured: status.configured,
      capability: status.capabilities[CAPABILITY[source]] as 'CONNECTED' | 'NOT_CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED',
      lastSyncCompletedAt: lastReadAt,
      lastRunOutcome: last?.outcome ?? null,
    },
    now,
    POLICY[source],
  );
  const inFlight = syncRunInFlight(last, now);
  return {
    source,
    freshness,
    readiness: sourceReadiness({ freshness, inFlight, everRead: lastReadAt !== null }),
    lastReadAt,
    inFlight,
    hasPosition: cursor?.cursor != null,
    failure: last?.outcome === 'FAILED' ? (last.failureClass ?? null) : null,
  };
}

/**
 * What Loop has read from each source it uses, for the Connections panel. Each source is read on
 * its own: one that cannot be read right now is simply absent, and the panel says it could not
 * check rather than guessing.
 */
export async function loadGoogleSourceViews(
  principal: WorkPrincipal,
  status: GoogleWorkspaceStatus,
): Promise<Partial<Record<'gmail' | 'calendar', { readonly readiness: SourceReadiness; readonly lastReadAt: Date | null }>>> {
  const now = new Date();
  const views: Partial<Record<'gmail' | 'calendar', { readonly readiness: SourceReadiness; readonly lastReadAt: Date | null }>> = {};
  await Promise.all(
    (['GMAIL', 'CALENDAR'] as const).map(async (source) => {
      try {
        const state = await loadSourceState(principal, source, status, now);
        views[CAPABILITY[source]] = { readiness: state.readiness, lastReadAt: state.lastReadAt };
      } catch {
        // Absent, never invented.
      }
    }),
  );
  return views;
}
