// What the Case Workspace reads.
//
// ONE COMPOSITION CONTRACT, ONE TENANT CHECK. `CaseWorkspaceService.case()`
// already assembles the brief, the finding, the recommendations, the
// participation, the coordination, the monitoring and the outcome behind a
// single organization-scoped gate. This file loads it and turns a thrown read
// into a named failure; it composes nothing itself, because a second composition
// here would be the parallel read model the brief forbids.
//
// A FAILED READ IS NOT AN EMPTY CASE. Same discriminated result as the Headlines
// surface, for the same reason: `CaseWorkspaceView | null` would let `?? []`
// render an outage as an investigation with no evidence.

import { CaseWorkspaceService, prisma } from '@emgloop/database';
import type { CaseWorkspaceView } from '@emgloop/database';

export type ReadResult<T> = { ok: true; value: T } | { ok: false; what: string };

async function attempt<T>(what: string, read: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    // The detail is deliberately dropped: an error message can carry row ids and
    // other tenants' identifiers, and the surface needs to know a read failed,
    // not what the database said about it.
    return { ok: false, what };
  }
}

/**
 * Everything one investigation is.
 *
 * NOT-FOUND AND CROSS-TENANT ARE THE SAME ANSWER. The service resolves the Case
 * within the organization and returns null either way, so this surface cannot be
 * used to discover that another tenant's investigation exists.
 */
export function loadCase(organizationId: string, caseId: string, now: Date = new Date()) {
  return attempt<CaseWorkspaceView | null>('this investigation', () =>
    new CaseWorkspaceService(prisma).case(organizationId, caseId, now),
  );
}
