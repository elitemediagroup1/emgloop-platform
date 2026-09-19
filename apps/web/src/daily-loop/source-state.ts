// Where one person's Gmail or Calendar stands: connected, and what Loop has actually read. SERVER ONLY.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §22.4 (freshness) and
// @emgloop/shared `deriveSourceState` -- the same derivation Read Employee Sources prints.
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
import { deriveSourceState, type SourceReadiness, type WorkSourceFreshness } from '@emgloop/shared';
import { WorkSourceRepository, prisma, type GoogleWorkspaceStatus, type WorkPrincipal } from '@emgloop/database';

export type ReadSource = 'GMAIL' | 'CALENDAR';

const CAPABILITY = { GMAIL: 'gmail', CALENDAR: 'calendar' } as const;

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
}

export async function loadSourceState(
  principal: WorkPrincipal,
  source: ReadSource,
  status: GoogleWorkspaceStatus,
  now: Date = new Date(),
): Promise<SourceState> {
  const sources = new WorkSourceRepository(prisma);
  const [cursor, runs] = await Promise.all([sources.cursor(principal, source), sources.recentRuns(principal, 1, source)]);
  // The one derivation every reader uses, including the operator's Read Employee Sources.
  const derived = deriveSourceState(
    source,
    { configured: status.configured, capability: status.capabilities[CAPABILITY[source]], cursor, lastRun: runs[0] ?? null },
    now,
  );
  return { source, ...derived };
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
